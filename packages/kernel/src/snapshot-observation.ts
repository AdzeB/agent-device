export type ObserveOnlyEvidence = Readonly<{
  mode: 'observe-only';
  capability: 'non-activating-foreground-v1';
  foregroundVerified: true;
  targetAppBundleId: string;
  /** Observation never activates; a capture that needed activation is refused instead. */
  activationPerformed: false;
  /**
   * The target's `XCUIApplication.state` re-read after capture, by name.
   * XCTest's report, not proof of foreground ownership (#2696).
   */
  appState: 'runningForeground';
  appStateSource: 'xcuiapplication-state';
}>;

export type ObserveOnlyRefusal = Readonly<{
  mode: 'observe-only';
  capability: 'non-activating-foreground-v1';
  foregroundVerified: false;
  activationPerformed: false;
  reason: string;
  targetAppBundleId?: string;
  appState?: string;
  appStateSource?: 'xcuiapplication-state';
  targetState?: number;
}>;
