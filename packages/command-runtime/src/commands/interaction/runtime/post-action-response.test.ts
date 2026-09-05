import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  createMemorySessionStore,
  localCommandPolicy,
} from '../../../runtime.ts';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { selector } from './selector-read-utils.ts';

function screen(label: string): SnapshotState {
  return makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Button',
      label,
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
}

async function pressThrough(
  snapshots: Array<SnapshotState | Error>,
  platform: 'ios' | 'android' = 'android',
) {
  let clock = 1_000;
  let captures = 0;
  let taps = 0;
  const before = screen('Continue');
  const device = createAgentDevice({
    backend: {
      platform,
      captureSnapshot: async () => {
        const snapshot =
          captures++ === 0 ? before : snapshots[Math.min(captures - 2, snapshots.length - 1)]!;
        if (snapshot instanceof Error) throw snapshot;
        return { snapshot };
      },
      tap: async () => {
        taps += 1;
        return { ok: true };
      },
    },
    artifacts: createLocalArtifactAdapter(),
    sessions: createMemorySessionStore([{ name: 'default', snapshot: before }]),
    policy: localCommandPolicy(),
    clock: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 50, timeoutMs: 2_000 },
  });
  return { result, captures, taps, stored: await device.sessions.get('default') };
}

test.each(['ios', 'android'] as const)(
  '%s settle preserves an intermediate response that disappears before the final ref frame',
  async (platform) => {
    const { result, captures, taps, stored } = await pressThrough(
      [screen('Pending'), screen('Request could not be completed'), screen('Ready')],
      platform,
    );
    assert.equal(result.settle?.settled, true);
    assert.deepEqual(
      result.settle?.response?.frames.map((frame) => frame.snapshot.nodes[0]?.label),
      ['Pending', 'Request could not be completed', 'Ready'],
    );
    assert.equal(result.settle?.response?.omittedFrames, 0);
    assert.equal(stored?.snapshot?.nodes[0]?.label, 'Ready');
    assert.equal(captures, 1 + result.settle!.captures);
    assert.equal(taps, 1);
  },
);

test('unchanged captures produce one historical frame without refs, values, or coordinates', async () => {
  const after = screen('Ready');
  after.nodes[0]!.value = 'unnecessary value';
  const { result } = await pressThrough([after]);
  const frames = result.settle?.response?.frames;
  assert.equal(frames?.length, 1);
  assert.deepEqual(frames?.[0], {
    capturedAt: 1_000,
    snapshot: { nodes: [{ type: 'Button', label: 'Ready' }] },
    truncated: false,
  });
});

test('retention caps frames and serialized content and discloses omissions', async () => {
  const huge = makeSnapshotState(
    Array.from({ length: 400 }, (_, index) => ({
      index,
      depth: 0,
      type: 'StaticText',
      label: `${index}${'界'.repeat(300)}`,
    })),
  );
  const { result } = await pressThrough([
    huge,
    ...Array.from({ length: 6 }, (_, i) => screen(`State ${i}`)),
  ]);
  const response = result.settle?.response;
  assert.equal(response?.frames.length, 4);
  assert.equal(response?.omittedFrames, 3);
  assert.equal(response?.frames[0]?.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(response!.frames[0])) <= 16_384);
});

test('editable and secure labels and aggregating ancestors never enter response evidence', async () => {
  const after = makeSnapshotState([
    { index: 0, depth: 0, type: 'Group', label: 'private aggregate' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'TextField',
      label: 'private input',
      editable: true,
    },
    { index: 2, depth: 0, type: 'SecureTextField', label: 'private password', password: true },
    { index: 3, depth: 0, type: 'StaticText', label: 'Request failed' },
  ]);
  const { result } = await pressThrough([after]);
  const response = result.settle?.response;
  assert.ok(response);
  assert.doesNotMatch(JSON.stringify(response), /private/);
  assert.match(JSON.stringify(response), /Request failed/);
});

test('node limits and full-content dedup do not mistake matching truncated prefixes for identical frames', async () => {
  const nodes = Array.from({ length: 300 }, (_, index) => ({
    index,
    depth: 0,
    type: 'StaticText',
    label: 'item',
  }));
  const first = makeSnapshotState(nodes);
  const second = makeSnapshotState(
    nodes.map((node) => (node.index === 299 ? { ...node, label: 'changed' } : node)),
  );
  const { result } = await pressThrough([first, second]);
  const frames = result.settle?.response?.frames;
  assert.equal(frames?.length, 2);
  assert.equal(frames?.[0]?.snapshot.nodes.length, 256);
  assert.equal(frames?.[0]?.truncated, true);
});

test('already captured response survives a later observation failure without replaying the action', async () => {
  const { result, taps } = await pressThrough([
    screen('Request failed'),
    new Error('capture unavailable'),
  ]);
  assert.equal(result.settle?.settled, false);
  assert.equal(result.settle?.response?.frames[0]?.snapshot.nodes[0]?.label, 'Request failed');
  assert.equal(result.settle?.diff, undefined);
  assert.equal(taps, 1);
});

test('depth-only native ancestors and role-based secure inputs suppress labels', async () => {
  const after = makeSnapshotState([
    { index: 0, depth: 0, type: 'Group', label: 'private aggregate' },
    { index: 1, depth: 1, type: 'Group', label: 'private nested' },
    { index: 2, depth: 2, type: 'android.widget.EditText', label: 'private input' },
    { index: 5, depth: 3, type: 'StaticText', label: 'private child value' },
    { index: 3, depth: 0, type: 'SecureTextField', label: 'private password' },
    { index: 4, depth: 0, type: 'StaticText', label: 'Request failed' },
  ]);
  const { result } = await pressThrough([after]);
  assert.doesNotMatch(JSON.stringify(result.settle?.response), /private/);
  assert.match(JSON.stringify(result.settle?.response), /Request failed/);
});
