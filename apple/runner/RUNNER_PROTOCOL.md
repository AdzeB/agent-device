# iOS Runner Protocol

The Apple runner speaks a small internal HTTP+JSON protocol between the TypeScript daemon and the XCUITest host. This protocol is a maintainer document, not part of the public user docs, but it should stay explicit so the TypeScript and Swift sides do not drift.

## Transport

- Endpoint: `POST /command`
- Content type: `application/json`
- Request body: one JSON command object
- Response body: one JSON envelope

The daemon probes `http://127.0.0.1:<port>/command` for simulator and desktop flows, and can use a tunneled device address for physical iOS/tvOS devices before falling back to localhost.

## Request Shape

Every request includes a `command` field. Additional fields depend on the command family.

Examples:

```json
{ "command": "tap", "x": 120, "y": 240 }
```

```json
{
  "command": "snapshot",
  "interactiveOnly": true,
  "depth": 2,
  "scope": "app",
  "raw": false,
  "customActions": false
}
```

`customActions` asks the capture to name each merged element's
`UIAccessibilityCustomAction`s in a node's `actions` array. It pins the
private-AX backend (no other backend can read them) and costs one accessibility
round trip per merged element, so it is opt-in.

The pass is bounded on four axes, and every bound is disclosed through
`snapshotQuality.customActions` `{read, candidates, truncated, blocked}` rather
than silently applied:

- at most 12 elements per capture, on-screen first, stopping at the capture
  deadline — `read < candidates` means the rest were not read;
- 1s per element read, so one wedged element cannot consume the capture budget
  (a timed-out element counts as unread, never as "read, has no actions");
- at most 8 action names per element, each at most 80 characters —
  `truncated` counts elements whose list was clipped;
- one read in flight at a time. The AX call cannot be cancelled once issued, so
  the deadline frees only the caller; the call itself keeps running. All reads
  therefore share one serial queue, and while an abandoned read is still
  outstanding the pass is skipped outright (`blocked`) instead of queueing
  behind it — repeating the capture adds no work. Reads resume on their own
  once the hung call returns.

```json
{ "command": "recordStart", "outPath": "/tmp/demo.mp4", "fps": 30 }
```

```json
{ "command": "rotate", "orientation": "landscape-left" }
```

The current command names are defined in:

- [`../../packages/platform-apple/src/runner/runner-client.ts`](../../packages/platform-apple/src/runner/runner-client.ts)
- [`AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift`](AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift)

## Response Shape

Successful and failed responses use the same top-level envelope:

```json
{
  "ok": true,
  "data": {
    "message": "ok"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_OPERATION",
    "message": "Unable to dismiss the iOS keyboard: the keyboard exposes no dismiss key (background taps are never attempted)"
  }
}
```

`data` is command-specific. Common fields include snapshot nodes, text lookup results, gesture timing, visibility metadata, and screenshot or recording output details.

## Foreground observation without activation

Read commands may opt into `"observeOnly": true` with an explicit `appBundleId`.
The daemon requires an already running compatible Apple runner; this mode never
starts, restarts, or adopts one. The native bridge checks the requested
`XCUIApplication.state` before and after capture. A background, suspended, stopped,
or unknown target returns unavailable without activation. Omission preserves the
normal command behavior.

The activation-free `uptime` response advertises
`observationCapabilities: ["non-activating-foreground-v1"]`. The daemon checks
this before sending an observation-only command, so an older retained native
runner cannot execute its activating snapshot path before being rejected.

Successful results retain this response-level proof:

```json
{
  "observation": {
    "mode": "observe-only",
    "capability": "non-activating-foreground-v1",
    "foregroundVerified": true,
    "targetAppBundleId": "com.example.app"
  }
}
```

Native refusals use `error.code: "OBSERVATION_UNAVAILABLE"` and
`error.observation` with the same mode/capability, `foregroundVerified: false`, a
typed `reason`, and the numeric `targetState` when measured. The daemon preserves
this under `error.details.observation`. Missing success proof is an incompatible
observer, not permission to trust the configured session identity or reactivate
the target. Secure masked values remain masked; this mode provides foreground
provenance, not private secure-value readback.

## Maintenance Rules

- Treat the TypeScript and Swift wire models as a single contract.
- When adding, removing, or renaming a command, update the protocol fixtures/tests in the same change.
- Keep this file focused on the actual wire shape rather than implementation details of command execution.
