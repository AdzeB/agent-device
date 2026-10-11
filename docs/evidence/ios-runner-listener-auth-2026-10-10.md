# Apple runner listener token - device verification (2026-10-10)

Baseline: `4037805738` (`origin/main`). Fix: branch `runner-listener-auth`.

Host: macOS 26.6, Xcode 26.2 (`17C52`). Device: iPhone 17 Pro, iOS 27.0, CoreDevice backend,
`<udid>`. The Mac joined the phone's Personal Hotspot, so the phone's network address
`<phone-wifi-ip>` is reachable from the Mac's Wi-Fi interface (`en0`) without the cable. Simulator:
iPhone 17 Pro, iOS 26.2, created for this run. Each run used a purpose-named `--session` and an
isolated `--state-dir` under `/private/tmp`; every session was closed and no lease, claim, or runner
process was left behind.

Probes that bypass the daemon were sent with `curl --interface en0` (or `nc`) to
`<phone-wifi-ip>:<runner-port>`, never over the cable or the CoreDevice tunnel.

## 4.1 Baseline on `4037805738`

| Lane | Probe | Result |
| --- | --- | --- |
| Physical, cabled | `POST /command` body `{}`, no token, to `<phone-wifi-ip>` | `400` (decoder error): listener reachable |
| Physical, cabled | `POST /command` body `{"command":"uptime"}`, no token, to `<phone-wifi-ip>` | `200 {"ok":true,...}`: command executed |
| Physical, cabled | `Content-Length: -5`, no token, to `<phone-wifi-ip>` | runner trapped (`Fatal error: Range requires lowerBound <= upperBound`); port refused afterwards |
| Simulator | `lsof` on the runner port | `TCP *:<port> (LISTEN)` (all interfaces) |
| Simulator | `POST /command` `{}` to `<mac-lan-ip>:<port>` | `400`: listener reachable from the LAN |
| Simulator | `Content-Length: -5` on loopback | same trap; listener gone |
| Simulator | 3 MB body on loopback | connection dropped, listener gone (`finish()` cancelled it) |

## 4.2 Positive paths on the fix

| Lane | Flow | Result |
| --- | --- | --- |
| Physical, cable (usbmux) | `open` Settings, `snapshot -i`, `click` search, `type`, `close` | all succeed; runner.log `AGENT_DEVICE_RUNNER_AUTH=required`, commands `ACCEPTED`/`COMPLETED` |
| Physical, Wi-Fi only | cable removed; usbmuxd `ListDevices` returns `[]`; devicectl shows `connected` | `open`, `snapshot -i`, `click`, `type` succeed over the tunnel route |
| Physical, handoff | `daemon stop` (graceful) | lease `ownerToken` -> `detached-owner-...`, `runnerToken` kept; `ios_runner_session_detached` with `"lane":"physical_coredevice"`; runner pid alive |
| Physical, adoption | next daemon `open --debug` | `ios_runner_lease_adoption_probe` 8 ms on the leased port, `ios_runner_lease_adopted`, same runner pid; following `click` accepted |
| Simulator | `open`, `snapshot -i`, `click` | succeed; listener `TCP 127.0.0.1:<port> (LISTEN)` |
| Simulator, retained runner | `close`, idle 25 s, `open` + `click` | same runner pid reused: the idle loopback listener watch is not cut by request deadlines |
| macOS (Calculator) | `open`, `snapshot -i`, `click`, `close` | succeed; listener `TCP 127.0.0.1:<port> (LISTEN)` |

## 4.3 Negative paths on the fix

| Lane | Probe | Result |
| --- | --- | --- |
| Physical | `{"command":"uptime"}` to `<phone-wifi-ip>`, no token | `401 UNAUTHORIZED`, no `COMMAND_ACCEPTED` in runner.log |
| Physical | wrong 32-byte token | `401` |
| Physical | `Content-Length: -5`, no token / with token | `401` / `400`; runner keeps serving |
| Physical | 3 MB body, no token / with token | `401` / `413`; runner keeps serving |
| Physical | connection that sends nothing | `408` |
| Physical | partial head (`POST /command HTTP/1.1\r\nX-Pad: a`), then stall | `408` |
| Physical | authenticated `uptime` after all of the above | `200` |
| Simulator | `<mac-lan-ip>:<port>` | connection refused (curl exit 7) |
| Simulator | loopback, no token | `401` with `X-Agent-Device-Runner-Auth: required` |
| Simulator | loopback: negative length / 3 MB / partial head | `400` / `413` / `408`; runner keeps serving |
| macOS | `<mac-lan-ip>:<port>` / loopback without token | refused / `401` |
| Physical, earlier-version runner | runner started and detached by `4037805738`, then the fix opens the device | `ios_runner_lease_adoption_skipped` `"reason":"runner_token_missing"`; old runner pid gone, its port refused; new lease carries `runnerToken` |

Token exposure (physical and simulator runs):

- Lease, session `.xctestrun`, and its `.json` are `-rw-------`.
- A recursive search of the state dirs and `~/.agent-device` for the token value matched only
  those files, plus, on the simulator, the xcresult staging `Session-*.log` that xcodebuild writes
  (`-rw-------`; it lists the runner environment).
- `ps axww` never shows it. On a simulator the runner is a Mac process, so the token is in that
  process's environment, which only the same user and root can read.
- In the xctestrun, only `EnvironmentVariables` carries it. `UITargetAppEnvironmentVariables`,
  `UITestEnvironmentVariables`, and `TestingEnvironmentVariables` do not, and the runner still reads
  it.

## 4.4 Interface-restriction experiment (not shipped)

A temporary build logged each accepted connection's path. Physical device only:

| Connection | Peer | Path |
| --- | --- | --- |
| Cable (usbmux) | loopback | `uses=loopback`, `available=lo0:loopback` |
| Wi-Fi only (CoreDevice tunnel) | non-loopback | `uses=wiredEthernet,other`, `available=utun7:other` |
| Direct to `<phone-wifi-ip>` (hotspot) | non-loopback | `uses=wiredEthernet`, `available=bridge100:wiredEthernet` |

With `prohibitedInterfaceTypes = [.wifi, .cellular, .wiredEthernet]` on the listener:

- Cable: works; the direct hotspot probe is refused (curl exit 7).
- Wi-Fi only: `open` times out after 90 s, and the runner logs no accepted connection. The tunnel
  connection's path reports the physical interface it rides on, so it is prohibited too.

The tunnel cannot be told apart from a direct peer by interface type, so the restriction breaks the
Wi-Fi-only lane and was reverted. These runs used Personal Hotspot, where the phone's side is
`bridge100` (`wiredEthernet`). On an ordinary Wi-Fi network the tunnel would be expected to report
`.wifi`, with the same result. That case was not run.

## Re-verification after the refactor

The refactor changed the runner's environment reading, collapsed the request deadlines into one
30 s deadline, wrote the port and token only into `EnvironmentVariables`, and removed the
`simctl spawn curl` simulator fallback. Re-run on that head:

| Lane | Check | Result |
| --- | --- | --- |
| Physical, cable | `open`, `snapshot -i`, `click`, `type` | succeed; `AUTH=required` |
| Physical | `<phone-wifi-ip>`, no token / idle connection | `401` / `408` |
| Simulator | `open`, `snapshot -i`, `click`; listener | succeed; `127.0.0.1:<port>` only |
| Simulator | LAN IP / loopback without token / partial head | refused / `401` / `408` |
| Simulator | session xctestrun | `AGENT_DEVICE_RUNNER_PORT` and `AGENT_DEVICE_RUNNER_TOKEN` only in `EnvironmentVariables` |
| Simulator, retained runner | `close`, idle 45 s, `open` + `click` | same runner pid reused |
| macOS | `open`, `snapshot -i`, `click`; no token | succeed; `127.0.0.1:<port>`; `401` |

## Re-verification after review fixes

The review fixes classify each runner connection by its path (loopback and CoreDevice tunnel
served, any other interface closed) in place of a shared connection cap, probe `uptime` before the
first mutation of a session that has not answered, and route the macOS host straight to loopback.
Mac on Personal Hotspot, then on an ordinary Wi-Fi network shared with the phone.

| Lane | Check | Result |
| --- | --- | --- |
| Physical, cable (usbmuxd lists the phone over USB) | `open`, `snapshot -i`, `click`, `type` | succeed |
| Physical, Wi-Fi only (usbmuxd lists nothing) | `open`, `snapshot -i`, `click`, `type` | succeed over the tunnel |
| Physical, both lanes | direct connection to `<phone-wifi-ip>`, with or without the token | closed without a reply (`curl` exit 52/56) |
| macOS | `open`, `snapshot -i`, `click`; listener; no token | succeed; `127.0.0.1:<port>`; `401` |
| Simulator | `open`, `snapshot -i`, `click`; no token; retained runner after 40 s idle | succeed; `401`; same runner pid |
| Physical, ordinary Wi-Fi, Wi-Fi only (usbmuxd lists nothing, phone answers ping on the LAN) | `open`, `snapshot -i`, `click`, `type` | succeed over the tunnel |
| Physical, ordinary Wi-Fi | direct connection to `<phone-lan-ip>`, with or without the token | closed without a reply (`curl` exit 52); the daemon keeps driving the phone |
