import XCTest

/// Response-level proof for an `observeOnly` command. `foregroundVerified` keeps its existing
/// meaning (the requested app was `runningForeground` before and after capture); the activation
/// and app-state fields record that the runner reached that answer without activating anything.
struct ObservationEvidence: Codable {
  let mode: String
  let capability: String
  let foregroundVerified: Bool
  let targetAppBundleId: String?
  var activationPerformed: Bool = false
  var appState: String? = nil
  var appStateSource: String? = nil
  var reason: String? = nil
  var targetState: UInt? = nil
}

extension RunnerTests {
  static let observationCapability = "non-activating-foreground-v1"
  static let observationAppStateSource = "xcuiapplication-state"

  /// The observe-only route: never activates, launches, or rebinds through `activateTarget`, so no
  /// `targetActivation` fact can be produced. A target that is not already foreground is refused.
  @MainActor
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
        targetState: state
      ))
    }
    refreshCachedTargetIfProcessChanged(bundleId: bundleId)
    if mainOwned.bundleId != bundleId {
      invalidateCachedTarget(reason: "observation_target_changed")
    }
    mainOwned.app = target
    mainOwned.bundleId = bundleId
    mainOwned.processIdentifier = Self.processIdentifier(of: target)
    return .context(ActiveCommandContext(app: target))
  }

  func completeObservation(command: Command, response: Response) throws -> Response {
    guard command.observeOnly == true else { return response }
    return try runMainThreadWork(
      "observation_completion",
      timeout: Self.mainThreadExecutionTimeout,
      timeoutError: Self.mainThreadExecutionTimeoutError
    ) { () -> Response in
      if self.pendingTargetActivation != nil {
        self.pendingTargetActivation = nil
        return self.observationUnavailable(command: command, reason: "activation_performed")
      }
      guard response.ok else { return response }
      switch self.prepareObservationContext(command: command) {
      case .response(let failure):
        return failure
      case .context(let context):
        var result = response
        var payload = result.data ?? DataPayload()
        payload.observation = ObservationEvidence(
          mode: "observe-only",
          capability: Self.observationCapability,
          foregroundVerified: true,
          targetAppBundleId: command.appBundleId?.trimmedNonEmpty,
          activationPerformed: false,
          appState: Self.applicationStateName(context.app.state),
          appStateSource: Self.observationAppStateSource
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
    targetState: XCUIApplication.State? = nil
  ) -> Response {
    Response(ok: false, error: ErrorPayload(
      code: "OBSERVATION_UNAVAILABLE",
      message: "Observation-only capture cannot establish the requested foreground target.",
      hint: "Use an explicitly authorized action to establish the target, then retry observation.",
      observation: ObservationEvidence(
        mode: "observe-only",
        capability: Self.observationCapability,
        foregroundVerified: false,
        targetAppBundleId: command.appBundleId?.trimmedNonEmpty,
        activationPerformed: reason == "activation_performed",
        appState: targetState.map { Self.applicationStateName($0) },
        appStateSource: targetState == nil ? nil : Self.observationAppStateSource,
        reason: reason,
        targetState: targetState.map { UInt($0.rawValue) }
      )
    ))
  }
}
