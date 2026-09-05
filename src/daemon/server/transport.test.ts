import net from 'node:net';
import { expect, it } from 'vitest';
import { createSocketServer, listenNetServer } from './transport.ts';
import { consumePrivateFieldComparison } from '../private-field-comparison.ts';

it('strips private wire input before invoking the daemon and scopes its consumption', async () => {
  let ordinaryRequest = '';
  const server = createSocketServer(async (req) => {
    ordinaryRequest = JSON.stringify(req);
    expect(consumePrivateFieldComparison()?.expectedValue).toBe('private fixture');
    return { ok: true, data: { status: 'unknown' } };
  });
  const port = await listenNetServer(server as net.Server);
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(
          JSON.stringify({
            command: 'get',
            positionals: ['attrs', '@e1~s2'],
            session: 'qa',
            privateFieldComparison: {
              protocol: 'android-private-input-v1',
              requestId: '12345678-1234-1234-1234-123456789abc',
              expectedValue: 'private fixture',
            },
          }) + '\n',
        );
      });
      socket.on('data', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });
    expect(ordinaryRequest).not.toContain('private');
    expect(consumePrivateFieldComparison()).toBeUndefined();
  } finally {
    server.destroyConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
