import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '@agent-device/kernel/errors';

export type PrivateFieldComparison = {
  protocol: 'android-private-input-v1';
  requestId: string;
  expectedValue: string;
};
type PrivateScope = { payload?: PrivateFieldComparison };
const outgoing = new AsyncLocalStorage<PrivateScope>();
const incoming = new AsyncLocalStorage<PrivateScope>();
export const PRIVATE_COMPARISON_MAX_BYTES = 32_768;

export function parsePrivateFieldComparison(value: unknown): PrivateFieldComparison {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== 'expectedValue,protocol,requestId' ||
    input.protocol !== 'android-private-input-v1' ||
    typeof input.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId) ||
    typeof input.expectedValue !== 'string' ||
    Buffer.byteLength(input.expectedValue, 'utf8') > 16_384
  )
    throw invalid();
  return input as PrivateFieldComparison;
}

function invalid(): AppError {
  return new AppError('INVALID_ARGS', 'Invalid private comparison payload');
}

async function scoped<T>(
  storage: AsyncLocalStorage<PrivateScope>,
  payload: PrivateFieldComparison | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scope: PrivateScope = { payload };
  const clear = () => {
    scope.payload = undefined;
  };
  const timer = setTimeout(clear, 60_000);
  timer.unref();
  signal?.addEventListener('abort', clear, { once: true });
  if (signal?.aborted) clear();
  try {
    return await storage.run(scope, run);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', clear);
    clear();
  }
}

export function withOutgoingPrivateFieldComparison<T>(
  payload: PrivateFieldComparison,
  run: () => Promise<T>,
): Promise<T> {
  return scoped(outgoing, payload, run);
}

export function hasOutgoingPrivateFieldComparison(): boolean {
  return outgoing.getStore() !== undefined;
}

export function serializePrivateSocketRequest(request: unknown): string {
  const scope = outgoing.getStore();
  const payload = scope?.payload;
  if (scope && !payload) throw invalid();
  if (scope) scope.payload = undefined;
  return JSON.stringify(
    payload ? { ...(request as object), privateFieldComparison: payload } : request,
  );
}

export function withPrivateFieldComparison<T>(
  payload: PrivateFieldComparison | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!payload) return run();
  return scoped(incoming, payload, run, signal);
}

export function consumePrivateFieldComparison(): PrivateFieldComparison | undefined {
  const scope = incoming.getStore();
  const payload = scope?.payload;
  if (scope && !payload) throw invalid();
  if (scope) scope.payload = undefined;
  return payload;
}
