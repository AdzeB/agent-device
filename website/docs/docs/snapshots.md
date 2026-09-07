---
title: Snapshots
---

# Snapshots

Snapshots provide a structured view of the UI and generate current-screen refs.

```bash
agent-device snapshot                    # Full accessibility tree
agent-device snapshot -i                 # Interactive elements only (recommended)
agent-device snapshot -d 3               # Limit depth to 3 levels
agent-device snapshot -s "Contacts"      # Scope to label/identifier
agent-device snapshot -i -d 5            # Combine options
agent-device snapshot --actions          # Name custom actions merged into elements (iOS simulator)
agent-device snapshot --observe-only     # Read without launching, activating, or recovering the target
agent-device diff snapshot               # Preferred structural diff vs previous session baseline
agent-device snapshot --diff             # Alias for the same diff operation
```

| Option           | Description                                                                     |
| ---------------- | ------------------------------------------------------------------------------- |
| `--diff`         | Structural diff against the previous session baseline (alias for `diff snapshot`) |
| `-i`             | Interactive-only output                                                          |
| `-d <depth>`     | Limit tree depth                                                                 |
| `-s <scope>`     | Scope to label or identifier                                                     |
| `--raw`          | Full provider tree instead of the visible-first agent view                       |
| `--actions`      | Name the custom accessibility actions merged inside an element (iOS simulator)   |
| `--observe-only` | Require evidence acquisition without launch, activation, focus changes, or recovery |
| `--force-full`   | Re-emit the full tree even when it is unchanged since the previous snapshot      |
| `--timeout <ms>` | Maximum wall-clock time for the snapshot command                                 |

`--actions` constraints:

- iOS simulators only. Physical iOS devices, macOS, and Android targets reject the flag.
- It names the affordances an element merged away (iOS `UIAccessibilityCustomAction`, React Native
  `accessibilityActions`), so a card whose reply/options controls are not separate elements still
  lists them.
- The names are for planning and discovery, not invocation. There is no API to trigger one: reach
  the affordance through the element's detail screen, through the same control exposed as a labeled
  element elsewhere, or by coordinates from its rect.
- Each merged element costs one accessibility round trip, so the pass is opt-in and bounded. When it
  cannot read every candidate, the response says how many it read — an absent list on an unread
  element is not evidence that it has none.
- Mutually exclusive with `--raw`. Custom actions are only readable through the private-AX capture
  path, which the raw diagnostic strategy does not take, so the pair is rejected as `INVALID_ARGS`
  before any device work — on the CLI, the Node client, and MCP alike. Choose one or the other.

## Observation without changing the target

`--observe-only` is an operator option for evidence that must describe the current target state.
It requires an existing local Apple app session with a ready runner; other backends fail. Prepare
the session and runtime before using it. The read cannot launch or activate an app, change focus,
or recover an app/runtime to acquire evidence. If the target cannot be read without such changes,
the command fails; that failure is unavailable evidence, not proof of an empty screen or an
absent element.

The flag defaults to `false` when omitted. It is excluded from the model-facing MCP and AI SDK
structured inputs. Operators can apply it to `snapshot`, selector-based `get text` and `get attrs`, `is`, and
`find` with an explicit `exists`, `list`, `get text`, `get attrs`, or `wait` action. A bare `find`
defaults to an interaction and is not allowed with this flag. `get text @ref` and `get attrs @ref`
are unsupported with `--observe-only`; use a selector instead. Top-level `wait`, `diff snapshot`,
and `snapshot --diff` do not accept it.

```bash
agent-device snapshot -i --observe-only
agent-device get attrs 'id="submit"' --observe-only
agent-device find "Confirmation" exists --observe-only
agent-device find "Confirmation" wait --observe-only
```

An observation does not freeze the application: its own asynchronous work can still change the
screen while the command reads or waits. The guarantee applies to changes initiated by evidence
acquisition.

## Efficient snapshot usage

Android structured snapshot nodes and `get attrs` expose native `editable`, `password`,
`hintShowing`, `selectionStart`, and `selectionEnd` facts when available. Missing fields mean
unknown; `hintShowing` requires Android API 26 or later. Selection values are accessibility
offsets, not character counts, and cannot verify a secure value or its equality to expected text.
An explicitly empty accessibility text remains `value: ""`; missing text remains unavailable.
These facts describe the accessibility observation, which may contain a hint or masked text,
rather than privileged access to an application's backing value.

- iOS and Android share the same mobile snapshot contract: visible-first output, actionable-now refs, and hidden list content communicated via discovery hints.
- Default to `snapshot -i` for agent loops.
- Default snapshot text is an agent-facing, token-efficient view for planning and targeting actions. It is visible-first and may collapse helper/accessibility noise; use `--raw` or `--json` when you need the full provider tree.
- Off-screen interactive content is collapsed into discovery summaries such as `[off-screen below] 3 interactive items: "Privacy", "Battery", "About"`.
- If a target only appears in an off-screen summary, use `scroll <direction>` and re-snapshot until the target becomes visible.
- When container ownership is known, hidden content is shown inline under the visible scroll/list container, for example `[content above scroll-area hidden]` or `[content below list hidden]`.
- Those summaries intentionally show only a few labels for token efficiency. Use `snapshot --raw` when you need the full off-screen tree instead of the summary.
- Add `-s "<label>"` (or `-s @ref`) to keep results screen-local.
- Add `-d <depth>` when you only need upper hierarchy layers.
- If `snapshot -i -d <n>` says the interactive output is empty at that depth, retry once without `-d` before taking more shallow snapshots.
- Re-snapshot after any UI mutation before reusing refs.
- On Android after navigation or submit, snapshot capture retries suspicious trees for a short post-action deadline and `@ref` interactions refresh while that freshness window is active. If `snapshot -i` still disagrees with the visible screen, trust `screenshot`, wait briefly, then take one fresh snapshot instead of looping stale snapshots.
- For automation runs affected by Android animation churn, use `settings animations off` as an opt-in stabilizer and restore with `settings animations on` after the run.
- Use `diff snapshot` between mutations to validate structural changes with lower output volume.
- Use `snapshot --diff` when you discover the feature from snapshot help, but keep `diff snapshot` as the default exploration command.
- Keep `--raw` for troubleshooting only when you need the full tree instead of visible-first output.

`diff snapshot` and `snapshot --diff` behavior:
- First run initializes baseline (`baselineInitialized: true` in JSON).
- Later runs return unified-style lines (`+` added, `-` removed, unchanged context) and update baseline after each call.

## Example output:

```bash
agent-device snapshot -i
# Output:
# Snapshot: 9 visible nodes (14 total)
# @e1 [application] "Contacts"
#   @e2 [window]
#     @e3 [other]
#   @e4 [other] "Lists"
#     @e5 [navigation-bar] "Lists"
#       @e6 [button] "Lists"
#       @e7 [text] "Contacts"
#     @e8 [other] "John Doe"
#       @e9 [other] "John Doe"
# [off-screen below] 2 interactive items: "All Contacts", "New List"
```

## iOS capture behavior

Capture tiers are internal. There is no flag that selects a backend; `--raw` chooses a strategy, and
the strategy owns which tiers it may use.

- Regular (non-`--raw`) capture uses the **regular visible strategy**: it starts with the recursive
  XCTest tree, and when that returns **sparse** output for a screen XCTest cannot serialize, it can
  recover through a query sweep and then, on simulators, a private accessibility backend.
- The ladder is bounded by the capture budget rather than retried indefinitely; when the budget is
  spent, the best payload captured so far is returned.
- Recovery and degradation stay observable instead of being presented as an empty UI. A
  **recovered** capture warns that it fell back to another backend and is safe to continue from; a
  **sparse** capture reports that no backend could read the screen and points you at `screenshot`
  as visual truth plus coordinate taps. Use `--json` and read `snapshotQuality` when you need the
  state, backend, and reason behind **degraded** output.
- A **sparse** `snapshot` takes that screenshot for you and returns its path as
  `fallbackScreenshotPath`, so the visual fallback costs no extra command. Remote clients download
  the image through the normal artifact channel before exposing that path. When the screen was
  reachable but published no accessibility content at all, the warning also names it as a likely app
  accessibility bug — assistive technologies get the same empty tree. Reasons that describe a limit
  of this tool instead (a refused or budget-exhausted capture) are not attributed to the app.
- `--raw` uses the **raw diagnostic strategy**: it stays tree-first and preserves strict capture
  failures, so a real XCTest accessibility serialization error surfaces as an error rather than as
  an empty tree.
- Private-accessibility recovery and `--actions` reads are simulator-specific. Physical iOS devices
  have no equivalent independent semantic backend; they bound the XCTest work with a probe instead.
