import assert from 'node:assert/strict';
import { test } from 'vitest';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import type { IosTargetActivation, ObserveOnlyEvidence } from '@agent-device/kernel/snapshot';
import { recordCaptureProof, withCaptureDisclosures } from '../capture-disclosure.ts';
import type { RequestCaptureProof } from '../capture-disclosure.ts';
import { RESPONSE_VIEWS } from '../response-views.ts';

const PROOF: ObserveOnlyEvidence = {
  mode: 'observe-only',
  capability: 'non-activating-foreground-v1',
  foregroundVerified: true,
  targetAppBundleId: 'com.example.app',
  activationPerformed: false,
  appState: 'runningForeground',
  appStateSource: 'xcuiapplication-state',
};
const REPAIR: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

test('F12: an observe-only capture publishes its proof and no targetActivation key', () => {
  const proof: RequestCaptureProof = {};
  recordCaptureProof(proof, { observation: PROOF });
  const response = withCaptureDisclosures({
    response: { ok: true, data: { nodes: [] } },
    consumedTree: { observation: PROOF },
    captureProof: proof,
  });
  assert.ok(response.ok);
  assert.deepEqual(response.data?.observation, PROOF);
  assert.equal('targetActivation' in (response.data ?? {}), false);
  assert.equal(response.data?.warnings, undefined);
});

test("a native refusal's own observation block is kept on failure", () => {
  const refusal = {
    mode: 'observe-only',
    foregroundVerified: false,
    activationPerformed: false,
    reason: 'target_not_foreground',
    appState: 'runningBackground',
    appStateSource: 'xcuiapplication-state',
  };
  const response = withCaptureDisclosures({
    response: {
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'refused', details: { observation: refusal } },
    },
    consumedTree: undefined,
    captureProof: { observation: PROOF },
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.deepEqual(response.error.details?.observation, refusal);
  assert.equal(response.error.details?.targetActivation, undefined);
});

test('F11: an ordinary repairing capture keeps the typed fact and its warning', () => {
  const proof: RequestCaptureProof = {};
  recordCaptureProof(proof, { targetActivation: REPAIR });
  const response = withCaptureDisclosures({
    response: { ok: true, data: { nodes: [], warnings: ['earlier'] } },
    consumedTree: { targetActivation: REPAIR },
    captureProof: proof,
  });
  assert.ok(response.ok);
  assert.deepEqual(response.data?.targetActivation, REPAIR);
  assert.deepEqual(response.data?.warnings, ['earlier', iosTargetActivationDisclosure(REPAIR)]);
  assert.equal(response.data?.observation, undefined);
});

test('the snapshot digest view carries both observation proof and repair facts', () => {
  const digest = RESPONSE_VIEWS.snapshot!(
    { nodes: [], observation: PROOF, targetActivation: REPAIR, warnings: ['w'] },
    'digest',
  );
  assert.deepEqual(digest.observation, PROOF);
  assert.deepEqual(digest.targetActivation, REPAIR);
  assert.deepEqual(digest.warnings, ['w']);
});
