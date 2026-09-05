import {
  findNodeByRef,
  normalizeRef,
  type SnapshotState,
  type SnapshotNode,
} from '@agent-device/kernel/snapshot';
import type { SelectorRuntimeParams } from './selector-runtime-backend.ts';
import type { DaemonResponse, SessionState } from './types.ts';
import { parseVersionedRefPositional } from './ref-positionals.ts';
import { readRefMutationFrame, readSessionRuntimeRevision } from './ref-frame.ts';
import { resolveBoundSelectorCapture } from './selector-capture-binding.ts';

export async function dispatchPrivateFieldComparison(
  params: SelectorRuntimeParams,
  request: { protocol: string; requestId: string; expectedValue: string },
): Promise<DaemonResponse> {
  const originalRef = params.req.positionals?.[1] ?? '';
  const session = params.sessionStore.get(params.sessionName);
  const base = {
    protocol: 'android-private-input-v1',
    requestId: request.requestId,
    sessionId: params.sessionName,
    ref: originalRef,
    source: 'android-ime-extracted-text',
  };
  const unknown = (reason: string): DaemonResponse => ({
    ok: true,
    data: { ...base, status: 'unknown', reason },
  });
  if (params.req.positionals?.[0] !== 'attrs' || !session || session.device.platform !== 'android')
    return unknown('unsupported');
  const owned = resolveOwnedTarget(session, originalRef);
  if (!owned) return unknown('target_unconfirmed');
  const { target, appId, generation } = owned;
  const revision = readSessionRuntimeRevision(session);
  try {
    const bound = await resolveBoundSelectorCapture({
      command: 'get',
      device: session.device,
      session,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (!bound.ok || !bound.operations.comparePrivateField) return unknown('unsupported');
    const result = await bound.operations.comparePrivateField({
      target,
      appId,
      expectedValue: request.expectedValue,
    });
    if (
      readSessionRuntimeRevision(session) !== revision ||
      params.sessionStore.get(params.sessionName) !== session
    )
      return unknown('session_changed');
    return { ok: true, data: { ...base, ...result, appId, refsGeneration: generation } };
  } catch {
    return unknown('comparison_unavailable');
  }
}

function resolveOwnedTarget(session: SessionState, originalRef: string) {
  const parsed = parseVersionedRefPositional(originalRef);
  if (!parsed.ok || parsed.generation === undefined) return undefined;
  const frame = readRefMutationFrame({
    session,
    ref: parsed.ref,
    mintedGeneration: parsed.generation,
  });
  if (!frame.admission.admitted || frame.scope !== 'all') return undefined;
  const tree = session.refFrameTree;
  if (!isCompleteNativeFrame(tree)) return undefined;
  const target = findNodeByRef(tree.nodes, normalizeRef(parsed.ref) ?? '');
  const appId = session.appBundleId;
  if (!appId || !isFocusedAppTarget(target, appId)) return undefined;
  return { target, appId, generation: parsed.generation };
}

function isCompleteNativeFrame(tree: SnapshotState | undefined): tree is SnapshotState {
  return (
    !!tree &&
    !tree.truncated &&
    tree.backend === 'android' &&
    tree.producer === 'android-uiautomator' &&
    !tree.systemSurfaceOnly
  );
}

function isFocusedAppTarget(target: SnapshotNode | null, appId: string): target is SnapshotNode {
  return (
    !!target && target.bundleId === appId && target.editable === true && target.focused === true
  );
}
