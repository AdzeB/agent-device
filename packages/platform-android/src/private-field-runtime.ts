import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  PrivateFieldComparisonInput,
  PrivateFieldComparisonResult,
} from '@agent-device/contracts/element-text-runtime';
import { readPrivateFieldEvidence } from '@agent-device/contracts/element-text-runtime';
import { resolveAndroidAdbExecutor } from './adb-executor.ts';
import { captureAndroidCompleteUiHierarchy } from './snapshot.ts';
import { resolveFocusedPrivateTarget } from './private-field-target.ts';
import {
  acquireAndroidPrivateInputScope,
  compareAndroidPrivateInput,
} from './private-input-comparison.ts';

export async function compareAndroidPrivateField(
  device: DeviceInfo,
  input: PrivateFieldComparisonInput,
  signal: AbortSignal,
): Promise<PrivateFieldComparisonResult> {
  try {
    signal.throwIfAborted();
    const original = readPrivateFieldEvidence(input.target);
    if (!original || original.appId !== input.appId)
      return { status: 'unknown', reason: 'original_scope_unavailable' };
    const execute = resolveAndroidAdbExecutor(device);
    const adb: typeof execute = (args, options) => execute(args, { ...options, signal });
    const scope = await acquireAndroidPrivateInputScope(adb, input.appId);
    if (
      !scope ||
      scope.connectionToken !== original.connectionToken ||
      scope.fieldId !== original.fieldId
    )
      return { status: 'unknown', reason: 'connection_changed' };
    const tree = await captureAndroidCompleteUiHierarchy(device, {
      signal,
      interactiveOnly: false,
    });
    if (!tree || !resolveFocusedPrivateTarget(tree, { ...input, windowId: original.windowId }))
      return { status: 'unknown', reason: 'target_unconfirmed' };
    signal.throwIfAborted();
    return await compareAndroidPrivateInput(adb, scope, input.expectedValue);
  } catch {
    return { status: 'unknown', reason: 'comparison_unavailable' };
  }
}
