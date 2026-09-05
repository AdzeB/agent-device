import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { attachPrivateFieldEvidence } from '@agent-device/contracts/element-text-runtime';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { ANDROID_EMULATOR } from './runtime.fixtures.ts';
import { compareAndroidPrivateField } from './private-field-runtime.ts';

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), compare: vi.fn(), capture: vi.fn() }));
vi.mock('./private-input-comparison.ts', () => ({
  acquireAndroidPrivateInputScope: mocks.acquire,
  compareAndroidPrivateInput: mocks.compare,
}));
vi.mock('./snapshot.ts', () => ({ captureAndroidCompleteUiHierarchy: mocks.capture }));
vi.mock('./adb-executor.ts', () => ({ resolveAndroidAdbExecutor: () => vi.fn() }));

test('requires proof from the original capture and rejects replaced input connections before recapture', async () => {
  const target: SnapshotNode = { ref: 'e1', index: 1 };
  const input = { target, appId: 'example.app', expectedValue: 'synthetic' };
  const signal = new AbortController().signal;
  assert.equal(
    (await compareAndroidPrivateField(ANDROID_EMULATOR, input, signal)).status,
    'unknown',
  );
  assert.equal(mocks.acquire.mock.calls.length, 0);
  attachPrivateFieldEvidence(target, {
    appId: input.appId,
    fieldId: 4,
    windowId: 7,
    connectionToken: 'original',
  });
  mocks.acquire.mockResolvedValue({
    appId: input.appId,
    fieldId: 4,
    connectionToken: 'replacement',
  });
  assert.deepEqual(await compareAndroidPrivateField(ANDROID_EMULATOR, input, signal), {
    status: 'unknown',
    reason: 'connection_changed',
  });
  assert.equal(mocks.capture.mock.calls.length, 0);
  assert.equal(mocks.compare.mock.calls.length, 0);
});
