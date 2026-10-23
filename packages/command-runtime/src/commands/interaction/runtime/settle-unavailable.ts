import { asAppError } from '@agent-device/kernel/errors';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import type { StableCaptureLoopResult } from './stable-capture.ts';

/** Report observation failure without failing the completed action. */
export function settleUnavailable(
  base: SettleObservation,
  outcome: Pick<StableCaptureLoopResult, 'captures' | 'waitedMs' | 'quietMs'> | undefined,
  error: unknown,
): { observation: SettleObservation } {
  return {
    observation: {
      ...base,
      captureError: settleCaptureError(error),
      captures: outcome?.captures ?? base.captures,
      waitedMs: outcome?.waitedMs ?? base.waitedMs,
      quietMs: outcome?.quietMs ?? base.quietMs,
      hint: `Settle observation unavailable (${error instanceof Error ? error.message : String(error)}). The action itself succeeded; take a snapshot to observe the result.`,
    },
  };
}

function settleCaptureError(error: unknown): NonNullable<SettleObservation['captureError']> {
  const failure = asAppError(error, 'COMMAND_FAILED');
  const observation = failure.details?.observation;
  const reason =
    observation && typeof observation === 'object'
      ? (observation as Record<string, unknown>).reason
      : undefined;
  return { code: failure.code, reason: typeof reason === 'string' ? reason : 'capture_failed' };
}
