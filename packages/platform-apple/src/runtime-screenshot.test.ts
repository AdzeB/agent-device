import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { NativePngStream } from '@agent-device/contracts/screenshot-runtime';

const runner = vi.hoisted(() => ({
  session: undefined as
    | undefined
    | { sessionId: string; logicalLeaseContext?: { leaseId?: string } },
  data: {} as Record<string, unknown>,
  calls: [] as Record<string, unknown>[],
}));
vi.mock('./runner/runner-session.ts', () => ({ getReadyRunnerSession: () => runner.session }));
vi.mock('./runner/runner-client.ts', () => ({
  runAppleRunnerCommand: async (_device: unknown, command: Record<string, unknown>) => {
    runner.calls.push(command);
    return runner.data;
  },
}));

const { bindAppleScreenshotRuntime } = await import('./runtime-screenshot.ts');

const DEVICE = { id: 'sim', platform: 'apple', appleOs: 'ios', kind: 'simulator' } as DeviceInfo;
const PROOF = {
  mode: 'observe-only',
  capability: 'non-activating-foreground-v1',
  foregroundVerified: true,
  targetAppBundleId: 'com.example.app',
  activationPerformed: false,
  appState: 'runningForeground',
  appStateSource: 'xcuiapplication-state',
};
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3]),
]).toString('base64');

function stream(input: Record<string, unknown> = {}) {
  const host = {
    localInteractors: { resolve: async () => ({}) },
  } as unknown as PlatformRuntimeHost;
  const runtime = bindAppleScreenshotRuntime(host, {
    device: DEVICE,
    signal: new AbortController().signal,
  });
  const images: NativePngStream[] = [];
  return {
    images,
    run: () =>
      runtime.captureScreenshot({
        options: { appBundleId: 'com.example.app' },
        consumePng: (image) => images.push(image),
        ...input,
      }),
  };
}

beforeEach(() => {
  runner.session = { sessionId: 'runner-1' };
  runner.data = { observation: PROOF, imageBase64: PNG };
  runner.calls = [];
});

test('a proven non-activating capture streams once through the observe-only runner command', async () => {
  const { images, run } = stream();
  await run();
  assert.equal(images.length, 1);
  assert.deepEqual(images[0]?.observation, PROOF);
  assert.deepEqual(runner.calls, [
    {
      command: 'screenshot',
      appBundleId: 'com.example.app',
      inlineScreenshot: true,
      observeOnly: true,
    },
  ]);
});

test('F10: a stream answered with a repair, missing proof, or invalid pixels is refused', async () => {
  for (const data of [
    { observation: PROOF, imageBase64: PNG, targetActivation: { reason: 'stale_target' } },
    { imageBase64: PNG },
    { observation: { ...PROOF, targetAppBundleId: 'com.other.app' }, imageBase64: PNG },
    { observation: PROOF, imageBase64: 'not png' },
  ]) {
    runner.data = data;
    const { images, run } = stream();
    await assert.rejects(run(), /Session-bound memory screenshot unavailable/);
    assert.equal(images.length, 0);
  }
});

test('F10/F5: no ready runner session or a file target refuses before the runner is asked', async () => {
  runner.session = undefined;
  await assert.rejects(stream().run(), /unavailable/);
  runner.session = { sessionId: 'runner-1' };
  await assert.rejects(stream({ outPath: '/tmp/x.png' }).run(), /unavailable/);
  assert.equal(runner.calls.length, 0);
});
