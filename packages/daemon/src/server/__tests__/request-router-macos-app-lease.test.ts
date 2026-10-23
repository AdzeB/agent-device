import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  MACOS_DEVICE,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeMacOsSession } from '../../__tests__/support/session-factories.ts';
import type { DaemonRequest } from '../../index.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { screenshotCommandSurface as testCreateCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';

const BUNDLE_ID = 'com.example.leased';
const LEASE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LEASE_META = {
  tenantId: 'tenant-a',
  runId: 'run-1',
  leaseId: LEASE_ID,
  sessionIsolation: 'tenant',
  leaseProvider: 'proxy',
  clientId: 'client-a',
  deviceKey: BUNDLE_ID,
  leaseBackend: 'macos-app',
} as const;

beforeEach(() => {
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function leasedRouter(appBundleId = BUNDLE_ID) {
  const sessionStore = makeSessionStore('agent-device-router-macos-app-lease-');
  sessionStore.publish(
    'tenant-a:default',
    makeMacOsSession('tenant-a:default', {
      appBundleId,
      surface: 'app',
      sessionScope: { kind: 'tenant', id: 'tenant-a' },
    }),
  );
  const leaseRegistry = new LeaseRegistry();
  leaseRegistry.putHostLease(LEASE_ID, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    leaseBackend: 'macos-app',
    deviceKey: BUNDLE_ID,
  });
  const runtime = screenshotRuntimeFixture();
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, sessionStore };
}

function leasedRequest(command: string, requestId: string, extra: Partial<DaemonRequest> = {}) {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    flags: { platform: 'macos' },
    meta: { requestId, ...LEASE_META },
    ...extra,
  } as DaemonRequest;
}

function hostFacts(sessionStore: ReturnType<typeof makeSessionStore>): string[] {
  return [sessionStore.resolveDaemonStateDir(), MACOS_DEVICE.name];
}

function expectNoHostFacts(response: DaemonResponse, facts: string[]): void {
  const wire = JSON.stringify(response);
  for (const fact of facts) expect(wire).not.toContain(fact);
  expect(wire).not.toContain('logPath');
  expect(wire).not.toContain('diagnosticsRecord');
}

test('a leased screenshot answers with the artifact handle and the tenant-chosen path only', async () => {
  const { handler, sessionStore } = leasedRouter();
  const remotePath = '/tmp/agent-device-screenshot-1700000000000-abc123.png';

  const response = await handler(
    leasedRequest('screenshot', 'req-shot', { positionals: [remotePath] }),
  );

  expect(response).toMatchObject({ ok: true, data: { path: remotePath } });
  expectNoHostFacts(response, hostFacts(sessionStore));
});

test('a refused leased request names no host log or path', async () => {
  const { handler, sessionStore } = leasedRouter();

  const response = await handler(leasedRequest('devices', 'req-devices'));

  expect(response).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  expectNoHostFacts(response, hostFacts(sessionStore));
});

test('a leased snapshot carries the app tree and nothing about the host', async () => {
  const { handler, sessionStore } = leasedRouter();

  const response = await handler(leasedRequest('snapshot', 'req-snapshot'));

  expect(response.ok).toBe(true);
  expectNoHostFacts(response, hostFacts(sessionStore));
});

const OBSERVE_ONLY_READS = [
  ['snapshot', []],
  ['get', ['text', 'label=Login']],
  ['is', ['visible', 'label=Login']],
  ['find', ['Confirmation', 'exists']],
] as const;

function macOsAppLeaseDenial(rule: string) {
  return {
    ok: false,
    error: { code: 'UNAUTHORIZED', details: { reason: 'MACOS_APP_LEASE_DENIED', rule } },
  };
}

test('an observe-only read of another app is refused like a plain read', async () => {
  const { handler } = leasedRouter('com.other.app');

  for (const [command, positionals] of OBSERVE_ONLY_READS) {
    for (const observeOnly of [false, true]) {
      const response = await handler(
        leasedRequest(command, `req-${command}-${observeOnly}`, {
          positionals: [...positionals],
          flags: { platform: 'macos', observeOnly },
        }),
      );
      expect(response, `${command} observeOnly=${observeOnly}`).toMatchObject(
        macOsAppLeaseDenial('app'),
      );
    }
  }
});

test('an observe-only read of the desktop surface is refused like a plain read', async () => {
  const { handler } = leasedRouter();

  for (const observeOnly of [false, true]) {
    const response = await handler(
      leasedRequest('snapshot', `req-desktop-${observeOnly}`, {
        flags: { platform: 'macos', surface: 'desktop', observeOnly },
      }),
    );
    expect(response, `observeOnly=${observeOnly}`).toMatchObject(macOsAppLeaseDenial('surface'));
  }
});

test('a request without a macos-app lease keeps its log locators', async () => {
  const sessionStore = makeSessionStore('agent-device-router-unleased-');
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: screenshotRuntimeFixture().gateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
    meta: { requestId: 'req-unleased' },
  });

  expect(response).toMatchObject({
    ok: false,
    error: { logPath: expect.stringContaining(sessionStore.resolveDaemonStateDir()) },
  });
});
