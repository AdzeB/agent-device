import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendSnapshotOptions } from '../../../backend.ts';
import type { ObserveOnlyEvidence, SnapshotState } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { selector } from './selector-read-utils.ts';
import {
  buttonSnapshot,
  createFakeClock,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';

// F9: `--settle --settle-observe-only` keeps the action's own authorization, asks every settle
// capture for the non-activating route, and never fails the action when that route is unavailable.

const PROOF: ObserveOnlyEvidence = {
  mode: 'observe-only',
  capability: 'non-activating-foreground-v1',
  foregroundVerified: true,
  targetAppBundleId: 'com.example.app',
  activationPerformed: false,
  appState: 'runningForeground',
  appStateSource: 'xcuiapplication-state',
};

function device(params: {
  capture: (
    options: BackendSnapshotOptions | undefined,
    index: number,
  ) => { snapshot: SnapshotState; observation?: ObserveOnlyEvidence };
  taps: { count: number };
}) {
  let index = 0;
  return createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async (_context, options) => params.capture(options, (index += 1)),
      tap: async () => {
        params.taps.count += 1;
        return { ok: true };
      },
      fill: async () => ({ ok: true }),
      longPress: async () => ({ ok: true }),
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([
      { name: 'default', snapshot: buttonSnapshot(), appBundleId: 'com.example.app' },
    ]),
    policy: localCommandPolicy(),
    clock: createFakeClock(),
  });
}

test('observe-only settle captures request the non-activating route; the action capture does not', async () => {
  const requested: (boolean | undefined)[] = [];
  const taps = { count: 0 };
  const agent = device({
    taps,
    capture: (options, index) => {
      requested.push(options?.observeOnly);
      if (index === 1) return { snapshot: buttonSnapshot() };
      return { snapshot: welcomeSnapshot(), observation: PROOF };
    },
  });

  const result = await agent.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { observeOnly: true },
  });

  assert.equal(taps.count, 1);
  assert.equal(requested[0], undefined, 'the authorized action resolves as usual');
  assert.ok(requested.length >= 2);
  assert.ok(requested.slice(1).every((value) => value === true));
  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.captureError, undefined);
  assert.deepEqual(settle.snapshot?.observation, PROOF);
  assert.equal('targetActivation' in settle, false);
});

test('a settle capture without non-activating proof leaves the action intact with a typed capture error', async () => {
  const taps = { count: 0 };
  const agent = device({
    taps,
    capture: (_options, index) =>
      index === 1 ? { snapshot: buttonSnapshot() } : { snapshot: welcomeSnapshot() },
  });

  const result = await agent.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { observeOnly: true },
  });

  assert.equal(taps.count, 1, 'the action is never replayed to recover observation');
  const settle = result.settle;
  assert.ok(settle);
  assert.equal(settle.settled, false);
  assert.deepEqual(settle.captureError, {
    code: 'COMMAND_FAILED',
    reason: 'observation_contract_mismatch',
  });
  assert.match(settle.hint ?? '', /action itself succeeded/);
});

test('early response frames captured before a later refusal are retained, bounded and redacted', async () => {
  const taps = { count: 0 };
  const secure = welcomeSnapshot();
  secure.nodes.push({
    ...secure.nodes[1]!,
    index: secure.nodes.length,
    ref: `e${secure.nodes.length + 1}`,
    type: 'SecureTextField',
    label: 'private secret',
  });
  const agent = device({
    taps,
    capture: (_options, index) => {
      if (index === 1) return { snapshot: buttonSnapshot() };
      if (index === 2) return { snapshot: secure, observation: PROOF };
      throw Object.assign(new Error('Non-activating foreground observation is unavailable'), {
        code: 'COMMAND_FAILED',
      });
    },
  });

  const result = await agent.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { observeOnly: true },
  });

  const settle = result.settle;
  assert.ok(settle);
  assert.ok(settle.captureError);
  const frames = settle.response?.frames ?? [];
  assert.equal(frames.length, 1);
  assert.ok(frames.length <= 4);
  assert.deepEqual(frames[0]?.snapshot.observation, PROOF);
  assert.equal(JSON.stringify(settle).includes('private secret'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(frames[0])) <= 16 * 1024);
});
