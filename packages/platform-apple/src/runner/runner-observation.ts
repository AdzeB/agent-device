import { AppError } from '@agent-device/kernel/errors';
import { readObserveOnlyEvidence } from '@agent-device/contracts/capture';
import type { RunnerCommand } from './runner-contract.ts';

const OBSERVE_ONLY_RUNNER_COMMANDS: ReadonlySet<RunnerCommand['command']> = new Set([
  'snapshot',
  'readText',
  'findText',
  'querySelector',
  'screenshot',
  'gestureViewport',
]);

type ObservationUnavailableReason =
  | 'runner_not_ready'
  | 'target_identity_missing'
  | 'unsupported_command'
  | 'unsupported_provider'
  | 'observation_contract_mismatch';

export function observationUnavailable(reason: ObservationUnavailableReason): AppError {
  return new AppError('COMMAND_FAILED', 'Non-activating foreground observation is unavailable', {
    observation: {
      mode: 'observe-only',
      capability: 'non-activating-foreground-v1',
      foregroundVerified: false,
      reason,
    },
  });
}

export function assertObserveOnlyRunnerCommand(command: RunnerCommand): void {
  if (!OBSERVE_ONLY_RUNNER_COMMANDS.has(command.command)) {
    throw observationUnavailable('unsupported_command');
  }
  if (!command.appBundleId?.trim()) {
    throw observationUnavailable('target_identity_missing');
  }
}

export function assertObserveOnlyRunnerResponse(
  command: RunnerCommand,
  data: Record<string, unknown>,
): void {
  const observation = readObserveOnlyEvidence(data.observation);
  if (
    data.runnerFatal === true ||
    !observation ||
    observation.targetAppBundleId !== command.appBundleId
  ) {
    throw observationUnavailable('observation_contract_mismatch');
  }
}

export function assertObserveOnlyRunnerCapability(data: Record<string, unknown>): void {
  if (
    data.runnerFatal === true ||
    !Array.isArray(data.observationCapabilities) ||
    !data.observationCapabilities.includes('non-activating-foreground-v1')
  ) {
    throw observationUnavailable('observation_contract_mismatch');
  }
}
