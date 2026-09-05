import { expect, it, vi } from 'vitest';
import { requirePrivateFieldDaemonIdentity } from './private-field-daemon-identity.ts';
import { sendRequest } from './daemon-client-transport.ts';
import { withOutgoingPrivateFieldComparison } from '../private-field-comparison.ts';
import { resolveDaemonPaths } from '../config.ts';
import { resolveLocalDaemonCodeSignature } from './daemon-launch-spec.ts';

vi.mock('@agent-device/host-kit/version', () => ({ readVersion: () => '0.20.11-a1' }));
vi.mock('./daemon-launch-spec.ts', () => ({
  resolveLocalDaemonCodeSignature: vi.fn(async () => 'graph:1:fixture'),
}));
const connection = vi.hoisted(() => vi.fn());
vi.mock('node:net', () => ({ default: { createConnection: connection } }));

const valid = {
  version: '0.20.11-a1',
  codeSignature: 'graph:1:fixture',
  token: 'fixture',
  pid: 1,
  port: 1,
};
it('accepts matching current identity and rejects older or unverified daemon metadata', async () => {
  await expect(requirePrivateFieldDaemonIdentity(valid)).resolves.toBeUndefined();
  for (const patch of [
    { version: '0.20.10' },
    { version: undefined },
    { codeSignature: undefined },
    { codeSignature: 'unknown' },
    { codeSignature: 'graph:1:old' },
  ]) {
    await expect(requirePrivateFieldDaemonIdentity({ ...valid, ...patch })).rejects.toThrow(
      'verified current daemon',
    );
  }
  vi.mocked(resolveLocalDaemonCodeSignature).mockResolvedValueOnce('unknown');
  await expect(requirePrivateFieldDaemonIdentity(valid)).rejects.toThrow('verified current daemon');
});

it('does not connect or serialize private input when startup returns stale metadata', async () => {
  connection.mockClear();
  const payload = {
    protocol: 'android-private-input-v1' as const,
    requestId: '12345678-1234-1234-1234-123456789abc',
    expectedValue: 'private regression fixture',
  };
  for (const patch of [
    { version: '0.20.10' },
    { codeSignature: undefined },
    { codeSignature: 'unknown' },
  ]) {
    const result = await withOutgoingPrivateFieldComparison(
      payload,
      async () =>
        await sendRequest(
          { ...valid, ...patch },
          { token: 'fixture', command: 'get', session: 'qa', positionals: ['attrs', '@e1~s2'] },
          'socket',
          resolveDaemonPaths('/tmp/private-field-identity-fixture'),
          100,
        ),
    );
    expect(result).toMatchObject({ ok: true, data: { status: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain(payload.expectedValue);
  }
  expect(connection).not.toHaveBeenCalled();
});
