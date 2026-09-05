import { hasSnapshotRef, type Point, type SnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '@agent-device/contracts/runtime-contract';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { buildSnapshotDiff } from '@agent-device/capture-kit/snapshot-diff';
import { displayLabel, formatRole } from '@agent-device/capture-kit/snapshot-lines';
import {
  collectSettleChromeRefs,
  withoutSettleChrome,
} from '@agent-device/capture-kit/snapshot-chrome';
import type {
  InteractionEvidence,
  PostActionSurfaceChange,
  ResolvedInteractionTarget,
  SettleObservation,
  SettleParams,
  SettleTailEntry,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import type { RuntimeCommand } from '../../runtime-types.ts';
import type { CapturedSnapshot } from './selector-read-shared.ts';
import { createPostActionResponseCollector } from './post-action-response.ts';
import {
  DEFAULT_STABLE_QUIET_MS,
  DEFAULT_STABLE_TIMEOUT_MS,
  runStableCaptureLoop,
  type StableCaptureLoopResult,
  TINY_STABLE_TREE_HINT,
  TINY_STABLE_TREE_NODE_COUNT,
} from './stable-capture.ts';
import {
  crossSurfaceSettleHint,
  resolvePostActionSurfaceChange,
  summarizePostActionEvidence,
} from './post-action-surface.ts';
import { settleUnavailable } from './settle-unavailable.ts';

/**
 * `--settle` (#1101): after a mutating command, wait for the UI to go quiet
 * (wait stable's loop, shared via stable-capture.ts) and return the settled
 * DIFF against the pre-action tree in the same response — one round trip
 * instead of the act → observe pair.
 *
 * Two entry points over one engine ({@link settleAfterAction}):
 * {@link settleAfterInteraction} for the targeted touch commands, which take
 * their baseline and proximity point from the resolution, and
 * {@link settleObservationCommand} for the target-less generic route
 * (`scroll`/`back`, #1638), which supplies the baseline itself and is reached
 * as a runtime command because the daemon may not import `commands/`.
 *
 * Best-effort by contract: this module never throws. The action already
 * succeeded when it runs; observation quality is advisory (same principle as
 * `--verify` evidence).
 */

export type SettleOutcome = {
  observation: SettleObservation;
  /** The final capture; doubles as the `--verify` evidence source. */
  settledCapture?: SurfaceScopedNodes;
};

// Changed-lines bound: the settled diff is the response payload, and unbounded
// added/removed lists on a full screen transition would crowd out everything
// else. The summary always carries the true counts.
const MAX_SETTLE_DIFF_LINES = 80;

// Unchanged-interactive-tail bound: same token-budget principle as the diff
// line cap, sized smaller since the tail is a fallback list, not the primary
// payload.
const MAX_SETTLE_TAIL_ENTRIES = 20;

export const NEVER_SETTLED_HINT =
  'The UI kept changing for the whole settle budget (animation, carousel, or ticker?), so no settled diff is shown. Raise --timeout, wait for specific content, or take a fresh snapshot.';

const SETTLE_CAPTURE_STALLED_HINT =
  'A snapshot capture stalled past the settle budget, so no settled diff is shown. The action itself succeeded; observe with wait stable or snapshot.';

export async function settleAfterInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  params: SettleParams & { resolved: ResolvedInteractionTarget },
): Promise<SettleOutcome> {
  return await settleAfterAction(runtime, options, {
    ...params,
    baseline: await resolveSettleBaseline(runtime, options, params.resolved),
    actionPoint: params.resolved.point,
  });
}

export type SettleObservationCommandOptions = CommandContext &
  SettleParams & {
    /** The pre-action tree the settled diff is taken against, and the surface it describes. */
    baseline: SurfaceScopedNodes;
  };

/**
 * The target-less settle as a RUNTIME COMMAND (#1638), which is how the daemon
 * reaches it: `scroll` and `back` run the generic route, and that dispatcher
 * may not import the command surface (R2) — it composes an `AgentDeviceRuntime`
 * and calls commands through it, exactly as the touch handlers do. Returns the
 * observation alone; the target-less path has no `--verify` companion to feed,
 * so the settled node list stays internal.
 */
export const settleObservationCommand: RuntimeCommand<
  SettleObservationCommandOptions,
  SettleObservation
> = async (runtime, options) => (await settleAfterAction(runtime, options, options)).observation;

/**
 * The target-less engine (#1638), for mutations that change the screen without
 * resolving an element. Same loop, storage, hints, and diff bounds as the
 * interaction entry point — only the two things a resolution would have
 * supplied come from the caller:
 *
 * - `baseline` is the diff baseline and the surface it describes. On the generic
 *   route the nodes are the session's STORED pre-action tree, which may be
 *   several commands older than the action, so the diff honestly reads "settled
 *   tree vs the last tree you observed" rather than press's freshly resolved
 *   pre-action capture.
 * - `actionPoint` is absent: with no point there is nothing to self-echo
 *   against, so the tail's self-echo exclusion simply never fires.
 */
async function settleAfterAction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  params: SettleParams & { baseline: SurfaceScopedNodes; actionPoint?: Point },
): Promise<SettleOutcome> {
  // The loop resolves an unrequested window from the capture that pays it, so the window is only
  // known once one is taken. `base` carries the general default for the pre-capture shape the
  // observation still has to report; once the loop returns, its own window replaces it, including on
  // a failure while the outcome is read.
  const timeoutMs = params.timeoutMs ?? DEFAULT_STABLE_TIMEOUT_MS;
      broadTransitionBaselineNodes: params.baseline.nodes,
      onCapture: (capture, capturedAt) => collector.capture(capture.snapshot.nodes, capturedAt),
