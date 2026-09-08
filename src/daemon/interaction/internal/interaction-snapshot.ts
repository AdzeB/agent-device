import { AppError } from '@agent-device/kernel/errors';
import { isActiveProviderDevice } from '../../../provider-device-runtime.ts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonCommandContext } from '../../context.ts';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { snapshotOptionsToFlags } from '../../../backend-snapshot-options.ts';
import type {
  BoundContextFromFlags,
  InteractionSessionView,
  InteractionSnapshotOptions,
} from './types.ts';

export type InteractionSnapshotCapture = (params: {
  flags: CommandFlags;
  options: InteractionSnapshotOptions;
  context: DaemonCommandContext;
}) => Promise<SnapshotState>;

export async function captureInteractionSnapshot(params: {
  session: InteractionSessionView;
  flags: CommandFlags | undefined;
  contextFromFlags: BoundContextFromFlags;
  options: InteractionSnapshotOptions;
  capture: InteractionSnapshotCapture;
  publishSnapshot: (snapshot: SnapshotState) => void;
}): Promise<SnapshotState> {
  const { session, flags, contextFromFlags, options } = params;
  if (options.observeOnly === true) assertGuardedInteractionCapture(session);
  const effectiveFlags = {
    ...(flags ?? {}),
    ...snapshotOptionsToFlags(options),
  };
  const dispatchContext = contextFromFlags(
    effectiveFlags,
    session.appBundleId,
    session.trace?.outPath,
  );
  const snapshot = await params.capture({
    flags: effectiveFlags,
    options,
    context: dispatchContext,
  });
  if (!isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) params.publishSnapshot(snapshot);
  return snapshot;
}

function assertGuardedInteractionCapture(session: InteractionSessionView): void {
  const unsupported =
    session.device.platform !== 'apple' ||
    session.device.appleOs === 'watchos' ||
    isActiveProviderDevice(session.device);
  if (unsupported) throw guardedCaptureError('unsupported_runtime');
  if (!session.appBundleId?.trim()) throw guardedCaptureError('target_identity_missing');
  if (session.surface !== undefined && session.surface !== 'app')
    throw guardedCaptureError('unsupported_surface');
}

function guardedCaptureError(reason: string): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    'Guarded settle capture requires a ready local Apple app session.',
    {
      observation: {
        mode: 'observe-only',
        capability: 'non-activating-foreground-v1',
        foregroundVerified: false,
        reason,
      },
    },
  );
}
