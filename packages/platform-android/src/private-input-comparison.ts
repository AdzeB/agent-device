import { randomBytes } from 'node:crypto';
import type { AndroidAdbExecutor } from './adb-transport.ts';

const PACKAGE = 'com.callstack.agentdevice.imehelper';
const PROTOCOL = 'android-private-input-v1';
const TIMEOUT_MS = 3_000;

export type AndroidPrivateInputScope = {
  connectionToken: string;
  appId: string;
  fieldId: number;
};

export type AndroidPrivateInputResult =
  | { status: 'unknown'; reason: string }
  | ({
      status: 'match' | 'mismatch';
      source: 'android-ime-extracted-text';
    } & AndroidPrivateInputScope);

export async function acquireAndroidPrivateInputScope(
  adb: AndroidAdbExecutor,
  appId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AndroidPrivateInputScope | undefined> {
  if (!/^[A-Za-z0-9_.]{1,256}$/.test(appId)) return undefined;
  try {
    const response = await adb(
      [
        'shell',
        'am',
        'broadcast',
        '--receiver-foreground',
        '-p',
        PACKAGE,
        '-a',
        `${PACKAGE}.ACTION_PRIVATE_INPUT_SCOPE`,
        '--es',
        'protocol',
        PROTOCOL,
        '--es',
        'appId',
        appId,
      ],
      { timeoutMs: options.timeoutMs ?? TIMEOUT_MS, signal: options.signal, allowFailure: true },
    );
    const result = response.exitCode === 0 ? parseResponse(response.stdout) : {};
    return result.reason === 'scope_acquired' ? scope(result, appId) : undefined;
  } catch {
    return undefined;
  }
}

/** Caller must bind this scope to its fresh focused target before comparing. */
export async function compareAndroidPrivateInput(
  adb: AndroidAdbExecutor,
  boundScope: AndroidPrivateInputScope,
  expectedValue: string,
): Promise<AndroidPrivateInputResult> {
  if (expectedValue.length > 16_000) return unknown('invalid_expected_value');
  const result = await request(adb, {
    protocol: PROTOCOL,
    operation: 'compare',
    ...boundScope,
    expectedValue,
  });
  const observedScope = scope(result, boundScope.appId);
  if (
    (result.status !== 'match' && result.status !== 'mismatch') ||
    !observedScope ||
    observedScope.connectionToken !== boundScope.connectionToken ||
    observedScope.fieldId !== boundScope.fieldId ||
    result.source !== 'android-ime-extracted-text'
  )
    return unknown('comparison_unavailable');
  const after = await acquireAndroidPrivateInputScope(adb, boundScope.appId);
  if (
    !after ||
    after.connectionToken !== boundScope.connectionToken ||
    after.fieldId !== boundScope.fieldId
  )
    return unknown('connection_changed');
  return { status: result.status, source: 'android-ime-extracted-text', ...observedScope };
}

function unknown(reason: string): AndroidPrivateInputResult {
  return { status: 'unknown', reason };
}

function scope(
  value: Record<string, unknown>,
  appId: string,
): AndroidPrivateInputScope | undefined {
  if (
    value.appId !== appId ||
    typeof value.connectionToken !== 'string' ||
    !/^[a-f0-9-]{36}:\d{1,16}$/.test(value.connectionToken) ||
    typeof value.fieldId !== 'number' ||
    !Number.isSafeInteger(value.fieldId)
  )
    return undefined;
  return { appId, connectionToken: value.connectionToken, fieldId: value.fieldId };
}

async function request(
  adb: AndroidAdbExecutor,
  payload: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  try {
    const stdin = JSON.stringify(payload);
    if (Buffer.byteLength(stdin) > 65_536) return {};
    const id = randomBytes(16).toString('hex');
    const written = await adb(
      ['shell', 'content', 'write', '--uri', `content://${PACKAGE}.private/request/${id}`],
      {
        stdin,
        timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
        signal: options.signal,
        allowFailure: true,
      },
    );
    if (written.exitCode !== 0) return {};
    const response = await adb(
      [
        'shell',
        'am',
        'broadcast',
        '--receiver-foreground',
        '-p',
        PACKAGE,
        '-a',
        `${PACKAGE}.ACTION_PRIVATE_INPUT`,
        '--es',
        'requestId',
        id,
      ],
      { timeoutMs: options.timeoutMs ?? TIMEOUT_MS, signal: options.signal, allowFailure: true },
    );
    return response.exitCode === 0 ? parseResponse(response.stdout) : {};
  } catch {
    return {};
  }
}

function parseResponse(stdout: string): Record<string, unknown> {
  if (stdout.length > 4096) return {};
  const match = /data="(\{[^\r\n]*\})"/.exec(stdout);
  if (!match?.[1]) return {};
  const parsed: unknown = JSON.parse(match[1]);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
