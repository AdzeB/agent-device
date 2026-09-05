import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { RequestProgressSink } from '@agent-device/contracts/progress';
import net from 'node:net';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { loadNodeHttpRequester, readNodeHttpResponseBody } from '@agent-device/host-kit/transport';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type {
  DaemonPaths,
  DaemonTransportPreference,
} from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readDaemonHttpProgressResponse,
  readDaemonSocketProgressResponse,
  shouldReadDaemonProgressStream,
} from './daemon-client-progress.ts';
import {
  buildDaemonHttpAuthHeaders,
  buildDaemonHttpUrl,
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
  DAEMON_HTTP_UPSTREAM_INSTANCE_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { buildHttpRpcPayload, handleDaemonHttpResponseBody } from './daemon-client-rpc.ts';
import { handleRequestTimeout } from './daemon-client-timeout.ts';
import { isRemoteDaemon, type DaemonInfo } from './daemon-client-metadata.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readVersion } from '@agent-device/host-kit/version';

type ResolvedDaemonTransport = 'socket' | 'http';
type SendRequestOptions = {
  /** The host whose working directory and environment this request's client-side work reads. */
  host: HostEnvironment;
  onProgress?: RequestProgressSink;
  /**
   * The caller's per-request cancellation (#3178). Aborted at or before a send attempt, nothing
   * leaves on that attempt; aborted in flight, the attempt's own connection is destroyed — which is
   * what makes the daemon mark the request canceled — and the promise rejects with the typed
   * canceled-request error. An abort is never a timeout: it never reaches `handleRequestTimeout`.
   */
  signal?: AbortSignal;
  /**
   * What a timed-out request may do to the daemon. `retire-unresponsive`, the default, lets the
   * liveness probe retire a daemon that answers nothing; `none` leaves every daemon alone, which is
   * how an attach client and the quiesce request itself time out.
   */
  timeoutRecovery?: 'retire-unresponsive' | 'none';
};

/**
 * The requester-side half of a per-call `AbortSignal` (#3178), kept beside the transport that
 * enforces it so cancellation has one owner across both halves. The transport half closes the
 * request's connection (which is what makes the daemon mark the request canceled); this half
 * answers for the cases a transport cannot observe:
 *
 * - a signal already aborted before anything is sent — nothing may leave the process, so the refusal
 *   carries `details.dispatched: 'no'`;
 * - an abort during a phase with no connection to close, or a custom transport that ignores the
 *   signal — the caller's promise still settles, with `details.dispatched: 'unknown'` because the
 *   request may already have been written.
 *
 * Both reject with the typed canceled-request error (`details.reason: 'request_canceled'`) whatever
 * reason the caller aborted with, so every layer dispatches on the same reason and never on the
 * caller's arbitrary abort reason or on error text. An abort is never a timeout: nothing here reads
 * or extends a request deadline, and no timeout path may produce this rejection.
 */

/**
 * The typed canceled-request error for a caller's own abort. The reason the caller aborted with
 * survives unchanged as the cause — `AbortController.abort()` accepts any value — while the
 * rejection itself dispatches on `reason: 'request_canceled'` with the delivery evidence the
 * aborting layer can prove. A built-in transport rejects every abort through this, so a caller's
 * arbitrary abort reason never escapes as the outcome of a daemon request.
 */
function abortedRequestError(
  signal: AbortSignal,
  dispatched: 'no' | 'unknown',
  requestId?: string,
): AppError {
  return createRequestCanceledError({ requestId, dispatched }, signal.reason);
}

/**
 * Refuses a send attempt that starts while the caller's signal is already aborted: nothing may leave
 * the process, so this never touches a connection and the refusal carries `details.dispatched: 'no'`.
 */
function refuseAbortedRequest(signal: AbortSignal | undefined, requestId?: string): void {
  if (!signal?.aborted) return;
  throw abortedRequestError(signal, 'no', requestId);
}

type RequestGuard = {
  /** Refuses an already-aborted call before anything is sent. No-op without a signal. */
  refuseIfAborted(): void;
  /** Settles `send`'s outcome against the signal, winning with the typed canceled error on abort. */
  guard<T>(send: () => Promise<T>): Promise<T>;
};

const NO_REQUEST_GUARD: RequestGuard = {
  refuseIfAborted: () => {},
  guard: async <T>(send: () => Promise<T>) => await send(),
};

export function createRequestGuard(params: {
  signal: AbortSignal | undefined;
  requestId?: string;
}): RequestGuard {
  const { signal, requestId } = params;
  if (!signal) return NO_REQUEST_GUARD;
  return {
    refuseIfAborted() {
      if (signal.aborted) throw abortedRequestError(signal, 'no', requestId);
    },
    guard: async <T>(send: () => Promise<T>): Promise<T> => {
      // Checked before `send` runs, so nothing has been dispatched yet — the honest evidence is
      // 'no'. An abort listener attached to an already-aborted signal never fires, so this check is
      // what keeps a late `guard` call rejecting rather than pending forever.
      if (signal.aborted) throw abortedRequestError(signal, 'no', requestId);
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortedRequestError(signal, 'unknown', requestId));
        signal.addEventListener('abort', onAbort, { once: true });
        void send().then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
  };
}

const LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS = 500;
const REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS = 3000;
const DAEMON_ENDPOINT_UNAVAILABLE_REASON = 'daemon_endpoint_unavailable';

export function isDaemonTransportUnavailableError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    error.details?.reason === DAEMON_ENDPOINT_UNAVAILABLE_REASON
  );
}

function daemonEndpointUnavailableError(transport: ResolvedDaemonTransport): AppError {
  return new AppError(
    'COMMAND_FAILED',
    transport === 'http'
      ? 'Daemon HTTP endpoint is unavailable'
      : 'Daemon socket endpoint is unavailable',
    { reason: DAEMON_ENDPOINT_UNAVAILABLE_REASON, transport },
  );
}

export type RemoteDaemonHealth = {
  reachable: boolean;
  statusCode?: number;
  service?: string;
  version?: string;
  rpcProtocolVersion?: number;
  instanceId?: string;
  hostArch?: string;
  /** The daemon behind a proxy, as the proxy's health reported it. */
  upstream?: RemoteDaemonHealthLink;
  /** The probe ran out of its time budget before an answer, rather than failing outright. */
  timedOut?: true;
};

type RemoteDaemonHealthLink = Pick<
  RemoteDaemonHealth,
  'service' | 'version' | 'rpcProtocolVersion' | 'instanceId' | 'hostArch'
>;

export async function canConnect(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  probeTimeoutMs?: number,
): Promise<boolean> {
  const deadline = Date.now() + (probeTimeoutMs ?? Number.POSITIVE_INFINITY);
  const transport = chooseTransport(info, preference);
  const fallback = chooseAutoFallbackTransport(info, preference, transport);
  const firstBudget = (deadline - Date.now()) / (fallback ? 2 : 1);
  if (await canConnectWithTransport(info, transport, firstBudget)) return Date.now() < deadline;
  return fallback
    ? (await canConnectWithTransport(info, fallback, deadline - Date.now())) &&
        Date.now() < deadline
    : false;
}

async function canConnectWithTransport(
  info: DaemonInfo,
  transport: ResolvedDaemonTransport,
  timeoutMs: number,
): Promise<boolean> {
  return transport === 'http'
    ? await canConnectHttp(info, timeoutMs)
    : await canConnectSocket(info.port, timeoutMs);
}

export function canConnectSocket(
  port: number | undefined,
  timeoutMs = LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS,
): Promise<boolean> {
  if (!port || timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      finish(true);
    });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(Math.min(LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS, Math.ceil(timeoutMs)));
    socket.on('timeout', () => {
      finish(false);
    });
    socket.on('error', () => {
      finish(false);
    });
  });
}

function canConnectHttp(info: DaemonInfo, timeoutMs: number): Promise<boolean> {
  return readDaemonHttpHealth(info, timeoutMs).then((health) => health.reachable);
}

export async function readRemoteDaemonHealth(
  info: DaemonInfo,
  probeTimeoutMs?: number,
  callerSignal?: AbortSignal,
): Promise<RemoteDaemonHealth> {
  const health = await readDaemonHttpHealth(info, probeTimeoutMs, callerSignal);
  if (!info.baseUrl || !health.reachable) return health;
  // Every link a command RPC crosses has to speak the client's protocol: a proxy that reports a
  // skewed daemon behind it fails here, before the RPC, exactly like a skewed proxy does.
  const incompatible = [health, health.upstream].find(
    (link) =>
      typeof link?.rpcProtocolVersion === 'number' &&
      link.rpcProtocolVersion !== DAEMON_RPC_PROTOCOL_VERSION,
  );
  if (incompatible) {
    throw new AppError('COMMAND_FAILED', 'Remote daemon RPC protocol is incompatible', {
      daemonBaseUrl: info.baseUrl,
      clientVersion: readVersion(),
      remoteVersion: incompatible.version,
      remoteService: incompatible.service,
      supportedRpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      remoteRpcProtocolVersion: incompatible.rpcProtocolVersion,
      hint: 'Upgrade agent-device on the client or remote host so both support the same daemon RPC protocol.',
    });
  }
  return health;
}

function daemonHealthEndpoint(info: DaemonInfo): string | null {
  return daemonHttpEndpoint(info, 'health');
}

function daemonHttpEndpoint(info: DaemonInfo, route: 'health' | 'rpc'): string | null {
  return info.baseUrl
    ? buildDaemonHttpUrl(info.baseUrl, route)
    : info.httpPort
      ? `http://127.0.0.1:${info.httpPort}/${route}`
      : null;
}

async function readDaemonHttpHealth(
  info: DaemonInfo,
  probeTimeoutMs?: number,
  callerSignal?: AbortSignal,
): Promise<RemoteDaemonHealth> {
  const endpoint = daemonHealthEndpoint(info);
  if (!endpoint) return { reachable: false };
  const url = new URL(endpoint);
  const timeoutMs = Math.min(
    info.baseUrl ? REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS : LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS,
    probeTimeoutMs ?? Number.POSITIVE_INFINITY,
  );
  if (timeoutMs <= 0) return { reachable: false, timedOut: true };
  const deadline = performance.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(Math.ceil(timeoutMs));
  const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
  const transport = await Promise.race([
    loadNodeHttpRequester(url.protocol),
    new Promise<null>((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
  ]);
  const unreachable = (): RemoteDaemonHealth => unreachableDaemonHealth(timeoutSignal, deadline);
  if (!transport || healthProbeExpired(signal, deadline)) return unreachable();
  return await new Promise((resolve) => {
    const headers = info.baseUrl ? buildDaemonHttpAuthHeaders(info.token) : {};
    const req = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
        signal,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 500;
          resolve(
            healthProbeExpired(timeoutSignal, deadline)
              ? { reachable: false, timedOut: true }
              : { reachable: statusCode < 500, statusCode, ...readHealthPayload(body) },
          );
        });
        res.on('error', () => resolve(unreachable()));
        res.on('aborted', () => resolve(unreachable()));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, timedOut: true });
    });
    req.on('error', () => {
      resolve(unreachable());
    });
    req.end();
  });
}

function unreachableDaemonHealth(timeoutSignal: AbortSignal, deadline: number): RemoteDaemonHealth {
  return healthProbeExpired(timeoutSignal, deadline)
    ? { reachable: false, timedOut: true }
    : { reachable: false };
}

function healthProbeExpired(signal: AbortSignal, deadline: number): boolean {
  return signal.aborted || performance.now() >= deadline;
}

function readHealthPayload(body: string): Omit<RemoteDaemonHealth, 'reachable' | 'statusCode'> {
  try {
    const parsed = JSON.parse(body) as { upstream?: unknown };
    const upstream =
      parsed.upstream && typeof parsed.upstream === 'object'
        ? readHealthLink(parsed.upstream as Record<string, unknown>)
        : undefined;
    return {
      ...readHealthLink(parsed as Record<string, unknown>),
      ...(upstream ? { upstream } : {}),
    };
  } catch {
    return {};
  }
}

function readHealthLink(parsed: Record<string, unknown>): RemoteDaemonHealthLink {
  return {
    service: typeof parsed.service === 'string' ? parsed.service : undefined,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    rpcProtocolVersion:
      typeof parsed.rpcProtocolVersion === 'number' ? parsed.rpcProtocolVersion : undefined,
    ...(typeof parsed.instanceId === 'string' ? { instanceId: parsed.instanceId } : {}),
    ...(typeof parsed.hostArch === 'string' ? { hostArch: parsed.hostArch } : {}),
  };
}

export async function sendRequest(
  info: DaemonInfo,
  req: DaemonWireRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  try {
    return await sendRequestWithFallback(info, req, preference, statePaths, timeoutMs, options);
  } catch (error) {
    if (!(error instanceof AppError) || error.details?.reason !== 'daemon_transport_timeout')
      throw error;
    const expiredBudget = error.details.timeoutMs;
    if (typeof expiredBudget !== 'number') throw error;
    throw await handleRequestTimeout({
      info,
      statePaths,
      retireUnresponsive: options.timeoutRecovery !== 'none',
      ...timeoutRequestContext(req, isRemoteDaemon(info), expiredBudget),
    });
  }
}

async function sendRequestWithFallback(
  info: DaemonInfo,
  req: DaemonWireRequest,
  preference: DaemonTransportPreference,
  statePaths: DaemonPaths,
  timeoutMs: number | undefined,
  options: SendRequestOptions,
): Promise<DaemonResponse> {
  const transport = chooseTransport(info, preference);
  const deadline = typeof timeoutMs === 'number' ? performance.now() + timeoutMs : undefined;
      try {
        const wire = serializePrivateSocketRequest(req);
        requestWritten = true;
        socket.write(`${wire}\n`);
      } catch {
        socket.destroy();
        reject(new AppError('INVALID_ARGS', 'Private comparison request expired'));
      }
