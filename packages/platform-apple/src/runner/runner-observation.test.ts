import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  assertObserveOnlyRunnerCapability,
  assertObserveOnlyRunnerCommand,
  assertObserveOnlyRunnerResponse,
  executeObserveOnlyRunnerExchange,
} from './runner-observation.ts';
import type { RunnerSession } from './runner-session-types.ts';

const COMMAND = { command: 'snapshot', appBundleId: 'com.example.app', observeOnly: true } as const;
const PROOF = {
  mode: 'observe-only',
  capability: 'non-activating-foreground-v1',
  foregroundVerified: true,
  targetAppBundleId: 'com.example.app',
  activationPerformed: false,
  appState: 'runningForeground',
  appStateSource: 'xcuiapplication-state',
};

function refusalReason(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError);
    const observation = error.details?.observation as Record<string, unknown>;
    assert.equal(observation.foregroundVerified, false);
    assert.equal(observation.activationPerformed, false);
    return observation.reason;
  }
  assert.fail('expected an observe-only refusal');
}

test('a response with matching non-activating proof is accepted', () => {
  assertObserveOnlyRunnerResponse(COMMAND, { observation: PROOF, nodes: [] });
});

test('F1/F12: a response that carries a repair is refused even beside valid proof', () => {
  const reason = refusalReason(() =>
    assertObserveOnlyRunnerResponse(COMMAND, {
      observation: PROOF,
      targetActivation: { reason: 'stale_target', priorState: 2 },
    }),
  );
  assert.equal(reason, 'observation_contract_mismatch');
});

test('F3: missing, partial, or foreign proof is refused', () => {
  for (const data of [
    {},
    { observation: { ...PROOF, appState: undefined } },
    { observation: { ...PROOF, targetAppBundleId: 'com.other.app' } },
    { observation: PROOF, runnerFatal: true },
  ]) {
    assert.equal(
      refusalReason(() => assertObserveOnlyRunnerResponse(COMMAND, data)),
      'observation_contract_mismatch',
    );
  }
});

test('F4: a runner that does not advertise the capability is refused', () => {
  assertObserveOnlyRunnerCapability({ observationCapabilities: ['non-activating-foreground-v1'] });
  for (const data of [{}, { observationCapabilities: [] }, { observationCapabilities: 'x' }]) {
    assert.equal(
      refusalReason(() => assertObserveOnlyRunnerCapability(data)),
      'observation_contract_mismatch',
    );
  }
});

test('commands outside the read set and commands without a target identity are refused', () => {
  assert.equal(
    refusalReason(() => assertObserveOnlyRunnerCommand({ command: 'tap', appBundleId: 'a' })),
    'unsupported_command',
  );
  assert.equal(
    refusalReason(() => assertObserveOnlyRunnerCommand({ command: 'snapshot' })),
    'target_identity_missing',
  );
});

test('F5: no ready session refuses before anything is sent', async () => {
  let invalidated = false;
  await assert.rejects(
    executeObserveOnlyRunnerExchange({
      device: { id: 'sim', platform: 'apple', kind: 'simulator' } as DeviceInfo,
      session: { port: 1 } as RunnerSession,
      command: COMMAND,
      logPath: undefined,
      timeoutMs: 1_000,
      isCurrentReadySession: () => false,
      invalidateFatalSession: async () => {
        invalidated = true;
      },
    }),
    (error: unknown) => {
      const observation = error instanceof AppError ? error.details?.observation : undefined;
      return (observation as { reason?: string } | undefined)?.reason === 'runner_not_ready';
    },
  );
  assert.equal(invalidated, false);
});
