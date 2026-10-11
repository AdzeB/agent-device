import Foundation
import Network

// MARK: - Environment

/// What the daemon hands the runner through the session xctestrun's `EnvironmentVariables`. Both
/// parts are required: a runner on a port of its own choosing is one no daemon can reach, and one
/// without a token would listen to anyone.
struct RunnerListenerConfiguration {
  let port: NWEndpoint.Port
  let token: RunnerListenerToken

  static func fromEnvironment(
    _ environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> RunnerListenerConfiguration? {
    guard
      let rawPort = environment["AGENT_DEVICE_RUNNER_PORT"].flatMap({ UInt16($0) }), rawPort > 0,
      let port = NWEndpoint.Port(rawValue: rawPort),
      let token = RunnerListenerToken(environment["AGENT_DEVICE_RUNNER_TOKEN"])
    else {
      return nil
    }
    return RunnerListenerConfiguration(port: port, token: token)
  }
}
