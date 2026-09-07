import XCTest

struct ObservationEvidence: Codable {
  let mode: String
  let capability: String
  let foregroundVerified: Bool
  let targetAppBundleId: String?
  var reason: String? = nil
  var targetState: UInt? = nil
}

extension RunnerTests {
  func prepareObservationContext(command: Command) -> ActiveCommandPreparation {
    guard supportsObservationOnly(command.command) else {
      return .response(observationUnavailable(command: command, reason: "unsupported_command"))
    }
    guard let bundleId = command.appBundleId?.trimmedNonEmpty else {
      return .response(observationUnavailable(command: command, reason: "target_identity_missing"))
    }
    let target = XCUIApplication(bundleIdentifier: bundleId)
    let state = target.state
    guard state == .runningForeground else {
      return .response(observationUnavailable(
        command: command,
        reason: "target_not_foreground",
        targetState: state.rawValue
      ))
    }
    refreshCachedTargetIfProcessChanged(bundleId: bundleId)
    if currentBundleId != bundleId {
      invalidateCachedTarget(reason: "observation_target_changed")
    }
    currentApp = target
    currentBundleId = bundleId
    currentAppProcessIdentifier = Self.processIdentifier(of: target)
    return .context(ActiveCommandContext(app: target))
  }

  func completeObservation(command: Command, response: Response) throws -> Response {
    guard command.observeOnly == true, response.ok else { return response }
    return try runMainThreadWork(
      timeout: mainThreadExecutionTimeout,
      timeoutError: mainThreadExecutionTimeoutError
    ) {
      switch self.prepareObservationContext(command: command) {
      case .response(let failure):
        return failure
      case .context:
        var result = response
        var payload = result.data ?? DataPayload()
        payload.observation = ObservationEvidence(
          mode: "observe-only",
          capability: "non-activating-foreground-v1",
          foregroundVerified: true,
          targetAppBundleId: command.appBundleId?.trimmedNonEmpty
        )
        result.data = payload
        return result
      }
    }
  }

  private func supportsObservationOnly(_ command: CommandType) -> Bool {
    switch command {
    case .snapshot, .readText, .findText, .querySelector, .screenshot, .gestureViewport:
      return true
    default:
      return false
    }
  }

  private func observationUnavailable(
    command: Command,
    reason: String,
    targetState: UInt? = nil
  ) -> Response {
    Response(ok: false, error: ErrorPayload(
      code: "OBSERVATION_UNAVAILABLE",
      message: "Observation-only capture cannot establish the requested foreground target.",
      hint: "Use an explicitly authorized action to establish the target, then retry observation.",
      observation: ObservationEvidence(
        mode: "observe-only",
        capability: "non-activating-foreground-v1",
        foregroundVerified: false,
        targetAppBundleId: command.appBundleId?.trimmedNonEmpty,
        reason: reason,
        targetState: targetState
      )
    ))
  }
}
