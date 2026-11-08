import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { maestroScriptSourceBundleFor } from '../../__tests__/support/replay-script-source-fixture.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';

const createCommandSurface: CreateDaemonCommandSurface = async (config) => {
  const screenshot = await screenshotCommandSurface(config);
  const touch = await createTouchCommandSurface()(config);
  return { ...screenshot, interactions: touch.interactions };
};

function harness(simulatorSetPath?: string) {
  const root = mkdtempForTestSync('remote-maestro-capture-');
  const store = makeSessionStore('remote-maestro-capture-store-');
  const session = makeIosSession('capture');
  if (simulatorSetPath) session.device = { ...session.device, simulatorSetPath };
  store.publish('capture', session);
  const runtime = screenshotRuntimeFixture({
    snapshotResult: () => ({
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: [{ index: 0, type: 'Application', rect: { x: 0, y: 0, width: 100, height: 100 } }],
    }),
  });
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore: store,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const run = async (steps: string) => {
    const flowPath = path.join(root, 'flow.yaml');
    fs.writeFileSync(flowPath, `appId: com.example.app\n---\n${steps}\n`);
    return await handler({
      token: 'test-token',
      session: 'capture',
      command: 'replay',
      positionals: [flowPath],
      flags: {
        platform: 'ios',
        replayBackend: 'maestro',
        replayScriptSource: await maestroScriptSourceBundleFor(flowPath),
      },
      internal: { publicNetworkOnly: true },
      meta: { requestId: 'remote-maestro', sessionExplicit: true },
    });
  };
  const cleanup = () => {
    for (const [input] of runtime.captureScreenshot.mock.calls) {
      fs.rmSync(input.outPath!, { force: true });
      try {
        fs.rmdirSync(path.dirname(input.outPath!));
      } catch {}
    }
  };
  return { root, handler, runtime, run, cleanup };
}

test('remote Maestro uses the bound named simulator set through nested router admission', async () => {
  const h = harness('/operator/simulator-set');
  try {
    const response = await h.run('- waitForAnimationToEnd: 0');
    expect(response).toMatchObject({ ok: true, data: { replayed: 1 } });
    expect(h.runtime.captureScreenshot).toHaveBeenCalledTimes(2);
    expect(
      h.runtime.binds.every(({ device }) => device.simulatorSetPath === '/operator/simulator-set'),
    ).toBe(true);
    const denied = await h.handler({
      token: 'test-token',
      session: 'capture',
      command: 'screenshot',
      positionals: [],
      flags: { iosSimulatorDeviceSet: '/operator/simulator-set' },
      internal: { publicNetworkOnly: true },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { details: { reason: 'REMOTE_HOST_INPUT_DENIED', field: 'iosSimulatorDeviceSet' } },
    });
  } finally {
    h.cleanup();
  }
});

test('remote Maestro animation wait consumes normalized screenshot paths and discharges settling', async () => {
  const h = harness();
  try {
    const response = await h.run(
      '- tapOn:\n    point: "10,10"\n- waitForAnimationToEnd: 0\n- tapOn:\n    point: "10,10"',
    );
    expect(response).toMatchObject({ ok: true, data: { replayed: 3 } });
    expect(h.runtime.tapPoint).toHaveBeenCalledTimes(2);
    expect(h.runtime.captureSnapshot).not.toHaveBeenCalled();
    expect(h.runtime.captureScreenshot).toHaveBeenCalledTimes(2);
    for (const [input] of h.runtime.captureScreenshot.mock.calls) {
      expect(fs.existsSync(input.outPath!)).toBe(false);
      expect(fs.existsSync(path.dirname(input.outPath!))).toBe(false);
    }
  } finally {
    h.cleanup();
  }
});

test('remote Maestro retries an unchanged iOS tap with real returned screenshot files', async () => {
  const h = harness();
  try {
    const response = await h.run('- tapOn:\n    point: "10,10"\n    retryTapIfNoChange: true');
    expect(response).toMatchObject({ ok: true, data: { replayed: 1 } });
    expect(h.runtime.tapPoint).toHaveBeenCalledTimes(2);
    expect(h.runtime.captureScreenshot).toHaveBeenCalledTimes(2);
    for (const [input] of h.runtime.captureScreenshot.mock.calls)
      expect(fs.existsSync(input.outPath!)).toBe(false);
  } finally {
    h.cleanup();
  }
});

test('remote Maestro takeScreenshot reports its generated path and preserves an absolute caller destination', async () => {
  const h = harness();
  const victim = path.join(h.root, 'victim.png');
  fs.writeFileSync(victim, 'protected');
  try {
    const response = await h.run(`- takeScreenshot: ${victim}`);
    expect(response).toMatchObject({ ok: true, data: { replayed: 1 } });
    expect(fs.readFileSync(victim, 'utf8')).toBe('protected');
    const actual = h.runtime.captureScreenshot.mock.calls[0]![0].outPath!;
    expect(actual).not.toBe(victim);
    expect(fs.existsSync(actual)).toBe(true);
    expect(response.ok && response.data?.artifactPaths).toContain(actual);
  } finally {
    h.cleanup();
  }
});
