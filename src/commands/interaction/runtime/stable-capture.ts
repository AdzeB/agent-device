import type {
  SnapshotNode,
  SnapshotPreferredBackend,
  SnapshotProvenance,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import { now, sleep } from '../../runtime-common.ts';
import {
  captureSelectorSnapshot,
  type CapturedSnapshot,
  type SelectorSnapshotOptions,
} from './selector-read-shared.ts';
import { runWithinWaitDeadline } from './wait-deadline.ts';
import {
  stableCaptureSignal,
  stableCaptureSignalsHaveBroadReplacement,
  stableCaptureSignalsEqual,
  type StableCaptureSignal,
} from './stable-capture-signal.ts';
import { preferredSnapshotBackendForVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { withoutSettleChrome } from '@agent-device/capture-kit/snapshot-chrome';

/**
 * The quiet-window stable-capture loop shared by `wait stable` and the
 * interaction `--settle` flag (#1101): capture the interactive-only tree,
 * digest it, and declare the UI stable once at least two captures in a row
 * stay identical for `quietMs`. The loop itself never throws and never
 * updates the session snapshot — callers map the outcome to their own
 * semantics (`wait stable` throws on timeout; `--settle` is best-effort and
 * reports `settled: false`).
 */

const STABLE_POLL_INTERVAL_MS = 300;
const STABLE_MIN_POLL_MS = 25;
// Never slower than the default poll, never faster than the minimum: a tight window gets a cadence
// that can measure it, and a window the confirmation extends is not sampled on the caller's grid.
function stableCapturePollMs(quietMs: number): number {
  return Math.min(STABLE_POLL_INTERVAL_MS, Math.max(STABLE_MIN_POLL_MS, quietMs));
}
// Wake PAST the quiet deadline rather than exactly on it. `setTimeout(n)` can
// advance `Date.now()` by only n-1 — libuv times the sleep on the monotonic
// loop clock while `now()` reads the wall clock — so a capture landing on the
// deadline decides `settled` by sub-millisecond skew rather than by the UI.
const QUIET_DEADLINE_EPSILON_MS = 2;
// Broad replacements (for example, dismissing a modal into a room) can expose a coherent but
// transitional AX tree for the default quiet window. Confirm those transitions longer without
// adding latency to local mutations whose pre/post trees substantially overlap.
const BROAD_TRANSITION_CONFIRMATION_QUIET_MS = 1_500;
export const DEFAULT_STABLE_QUIET_MS = 500;
/**
 * The default quiet window each producer's capture earns. The iOS simulator snapshot bridge answers
 * well inside the general default, so holding the general window on that read spends a whole extra
 * capture on a window its tree had already satisfied. Keyed on the producer, not the channel: the
 * bridge and the Apple runner share the `xctest` channel and read at different costs, and only the
 * bridge carries the measurement. Every producer states its price here, so a new one cannot inherit
 * an unmeasured window by omission. (PR #3522 holds the interleaved before/after medians and the
 * late-diff accuracy check.)
 */
const DEFAULT_QUIET_MS_BY_PRODUCER = {
  'apple-runner': DEFAULT_STABLE_QUIET_MS,
  'simulator-ax-bridge': 300,
  'appium-source': DEFAULT_STABLE_QUIET_MS,
  'limrun-ios-tree': DEFAULT_STABLE_QUIET_MS,
  'android-uiautomator': DEFAULT_STABLE_QUIET_MS,
  'harmonyos-uitest': DEFAULT_STABLE_QUIET_MS,
  'macos-helper': DEFAULT_STABLE_QUIET_MS,
  'linux-atspi': DEFAULT_STABLE_QUIET_MS,
  'agent-browser': DEFAULT_STABLE_QUIET_MS,
} as const satisfies Record<SnapshotProvenance['producer'], number>;

/** A capture that declares no producer has no measured price and keeps the general default. */
function defaultQuietMsForCapture(snapshot: SnapshotState): number {
  return snapshot.producer === undefined
    ? DEFAULT_STABLE_QUIET_MS
    : DEFAULT_QUIET_MS_BY_PRODUCER[snapshot.producer];
}
export const DEFAULT_STABLE_TIMEOUT_MS = 10_000;
// Below this node count a settled tree is suspicious: real app surfaces have
// more than a handful of accessibility nodes, splash/loading screens do not.
export const TINY_STABLE_TREE_NODE_COUNT = 5;
// A settled-but-tiny tree usually means a splash/loading surface, not real
// content: stability alone is a weak readiness signal there.
export const TINY_STABLE_TREE_HINT =
  'Settled on a nearly-empty tree — the app may still be loading. Wait for specific content (wait text ...) before interacting.';

export type StableCaptureLoopResult = {
  /** Two identical captures held the quiet window before the deadline. */
  settled: boolean;
  /** A capture stalled past the remaining deadline (no verdict available). */
  stalled: boolean;
  waitedMs: number;
  captures: number;
  nodeCount: number;
  /**
   * The quiet window the run was holding when it returned: the caller's, or the default resolved
   * from the last capture that paid it. A run that completed no capture never priced a window, so
   * it reports the general default it started from.
   */
  quietMs: number;
  /** The most recent completed capture, settled or not. */
  lastCapture?: CapturedSnapshot;
  /** A capture threw; the run ended there, without a verdict. */
  failure?: { error: unknown };
};

export async function runStableCaptureLoop(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  params: {
    /**
     * The quiet window the caller asked for. Absent means the loop resolves its own default from
     * the capture it performs, because that capture is the read the window prices
     * ({@link defaultQuietMsForCapture}); a caller with its own default passes it explicitly.
     */
    quietMs?: number;
    timeoutMs: number;
    resetBudgetOnPrivateAxRecovery?: boolean;
    /** Immutable pre-action projection; the stored session may advance before settle begins. */
    params.onCapture?.(capture, now(runtime));
