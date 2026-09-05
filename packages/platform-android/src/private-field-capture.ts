import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { attachPrivateFieldEvidence } from '@agent-device/contracts/element-text-runtime';
import {
  acquireAndroidPrivateInputScope,
  type AndroidPrivateInputScope,
} from './private-input-comparison.ts';
import { isAndroidTestImeActive } from './ime-state.ts';
import { resolveFocusedPrivateTarget } from './private-field-target.ts';
import type { AndroidUiHierarchy } from './ui-hierarchy.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import type { AndroidSnapshotBackendMetadata } from './snapshot-types.ts';

export async function beginPrivateFieldCapture(
  device: DeviceInfo,
  adb: AndroidAdbExecutor,
  appId?: string,
  signal?: AbortSignal,
) {
  return appId && isAndroidTestImeActive(device) ? await acquire(adb, appId, signal) : undefined;
}

export async function finishPrivateFieldCapture(input: {
  adb: AndroidAdbExecutor;
  scope?: AndroidPrivateInputScope;
  signal?: AbortSignal;
  nodes: RawSnapshotNode[];
  tree: AndroidUiHierarchy;
  metadata: AndroidSnapshotBackendMetadata;
  truncated?: boolean;
}): Promise<void> {
  const { scope } = input;
  if (!scope || input.truncated || !isComplete(input.metadata)) return;
  const after = await acquire(input.adb, scope.appId, input.signal);
  if (after?.connectionToken !== scope.connectionToken || after.fieldId !== scope.fieldId) return;
  for (const node of input.nodes) {
    if (node.focused !== true || node.editable !== true) continue;
    const focused = resolveFocusedPrivateTarget(input.tree, { target: node, appId: scope.appId });
    if (focused?.windowId !== undefined)
      attachPrivateFieldEvidence(node, { ...scope, windowId: focused.windowId });
  }
}

function isComplete(metadata: AndroidSnapshotBackendMetadata): boolean {
  return (
    metadata.helperTruncated === false &&
    metadata.rootPresent === true &&
    !metadata.systemSurfaceOnly
  );
}

async function acquire(adb: AndroidAdbExecutor, appId: string, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(3_000);
  return await acquireAndroidPrivateInputScope(adb, appId, {
    timeoutMs: 3_000,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}
