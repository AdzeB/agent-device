import type { DaemonResponse } from './types.ts';

const protocol = 'android-private-input-v1';

export function sanitizePrivateFieldResponse(response: DaemonResponse): DaemonResponse {
  const unavailable: DaemonResponse = {
    ok: true,
    data: { protocol, status: 'unknown', reason: 'private-comparison-response-invalid' },
  };
  if (!response.ok || !response.data || typeof response.data !== 'object') return unavailable;
  const data = response.data as Record<string, unknown>;
  if (data.protocol !== protocol || !['match', 'mismatch', 'unknown'].includes(String(data.status)))
    return unavailable;
  const result: Record<string, unknown> = { protocol, status: data.status };
  if (!copyStringProvenance(data, result)) return unavailable;
  if (!copyNumericProvenance(data, result)) return unavailable;
  if (!hasRequiredProvenance(result)) return unavailable;
  return { ok: true, data: result };
}

function copyStringProvenance(
  data: Record<string, unknown>,
  result: Record<string, unknown>,
): boolean {
  const fields: Record<string, RegExp> = {
    requestId: /^[0-9a-f-]{36}$/i,
    sessionId: /^[A-Za-z0-9_.-]{1,128}$/,
    ref: /^@e\d+~s\d+$/,
    source: /^android-ime-extracted-text$/,
    appId: /^[A-Za-z0-9_.]{1,255}$/,
    connectionToken: /^[A-Za-z0-9_.:-]{1,128}$/,
    reason: /^[a-z0-9_-]{1,128}$/,
  };
  for (const [key, pattern] of Object.entries(fields)) {
    if (data[key] === undefined) continue;
    if (typeof data[key] !== 'string' || !pattern.test(data[key])) return false;
    result[key] = data[key];
  }
  return true;
}

function copyNumericProvenance(
  data: Record<string, unknown>,
  result: Record<string, unknown>,
): boolean {
  for (const key of ['refsGeneration', 'fieldId']) {
    if (data[key] === undefined) continue;
    if (!Number.isSafeInteger(data[key])) return false;
    result[key] = data[key];
  }
  return true;
}

function hasRequiredProvenance(result: Record<string, unknown>): boolean {
  if (
    result.status !== 'unknown' &&
    [
      'requestId',
      'sessionId',
      'ref',
      'source',
      'appId',
      'connectionToken',
      'refsGeneration',
      'fieldId',
    ].some((key) => result[key] === undefined)
  )
    return false;
  return true;
}
