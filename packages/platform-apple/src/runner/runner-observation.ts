import { AppError } from '@agent-device/kernel/errors';
import { readObserveOnlyEvidence } from '@agent-device/contracts/capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { Deadline } from './host.ts';
import { withRunnerCommandId, type RunnerCommand } from './runner-contract.ts';
import { sendRunnerCommandOnce } from './runner-transport.ts';
import { executeRunnerExchange, parseRunnerResponse } from './runner-exchange.ts';
import type { RunnerSession } from './runner-session-types.ts';

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
      activationPerformed: false,
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
    data.targetActivation !== undefined ||
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

/**
 * The observe-only exchange: only an already-ready session is used, the runner must advertise the
 * non-activating capability before the command is sent, and the answer must carry the matching
 * proof and no activation fact. Nothing here starts, restarts, or adopts a runner.
 */
export async function executeObserveOnlyRunnerExchange(params: {
  device: DeviceInfo;
  session: RunnerSession;
  command: RunnerCommand;
  logPath: string | undefined;
  timeoutMs: number;
  isCurrentReadySession: () => boolean;
  invalidateFatalSession: (reason: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { device, session, command, signal } = params;
  assertObserveOnlyRunnerCommand(command);
  if (!params.isCurrentReadySession()) throw observationUnavailable('runner_not_ready');
  const deadline = Deadline.fromTimeoutMs(params.timeoutMs);
  const capability = await parseRunnerResponse(
    await sendRunnerCommandOnce(
      device,
      session.port,
      withRunnerCommandId({ command: 'uptime' }),
      deadline.remainingMs(),
      signal,
    ),
    session,
  );
  assertObserveOnlyRunnerCapability(capability);
  if (!params.isCurrentReadySession()) throw observationUnavailable('runner_not_ready');
  const data = await executeRunnerExchange(
    device,
    session,
    command,
    params.logPath,
    deadline.remainingMs(),
    params.invalidateFatalSession,
    signal,
  );
  assertObserveOnlyRunnerResponse(command, data);
  return data;
}
