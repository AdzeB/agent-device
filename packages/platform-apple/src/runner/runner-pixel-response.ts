import { isRecord } from '@agent-device/kernel/record';
import { AppError } from '@agent-device/kernel/errors';

export async function readPixelResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 16 * 1024 * 1024) throw unavailable();
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) throw unavailable();
    return value.data as Record<string, unknown>;
  } catch {
    throw unavailable();
  } finally {
    await reader.cancel().catch(() => {});
    for (const chunk of chunks) chunk.fill(0);
  }
}

function unavailable(): AppError {
  return new AppError('COMMAND_FAILED', 'Memory screenshot response unavailable');
}
