import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbExecutor } from './adb-transport.ts';
import {
  acquireAndroidPrivateInputScope,
  compareAndroidPrivateInput,
} from './private-input-comparison.ts';

const bound = {
  appId: 'example.app',
  fieldId: 9,
  connectionToken: '01234567-0123-0123-0123-012345678901:1',
};

function transport(status: 'match' | 'mismatch', changed = false) {
  let payload: Record<string, unknown> = {};
  const argsSeen: string[][] = [];
  const adb: AndroidAdbExecutor = async (args, options) => {
    argsSeen.push(args);
    if (options?.stdin) {
      payload = JSON.parse(String(options.stdin));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const result =
      payload.operation === 'acquire'
        ? {
            status: 'unknown',
            reason: 'scope_acquired',
            ...bound,
            connectionToken: changed
              ? bound.connectionToken.replace(':1', ':2')
              : bound.connectionToken,
          }
        : { status, ...bound, source: 'android-ime-extracted-text' };
    return {
      exitCode: 0,
      stdout: `Broadcast completed: result=0, data="${JSON.stringify(result)}"`,
      stderr: '',
    };
  };
  return { adb, argsSeen };
}

test('private comparison preserves match and same-length mismatch without expected data in argv', async () => {
  for (const status of ['match', 'mismatch'] as const) {
    const { adb, argsSeen } = transport(status);
    assert.equal(
      (await compareAndroidPrivateInput(adb, bound, 'synthetic-private-value')).status,
      status,
    );
    assert.ok(!JSON.stringify(argsSeen).includes('synthetic-private-value'));
    assert.ok(
      argsSeen
        .filter((args) => args.includes('broadcast'))
        .every((args) => args.includes('--receiver-foreground')),
    );
  }
});

test('generation change after extraction rejects a matching result', async () => {
  assert.deepEqual(await compareAndroidPrivateInput(transport('match', true).adb, bound, '1234'), {
    status: 'unknown',
    reason: 'connection_changed',
  });
});

test('acquisition validates connection provenance', async () => {
  assert.deepEqual(
    await acquireAndroidPrivateInputScope(transport('match').adb, bound.appId),
    bound,
  );
  assert.equal(
    await acquireAndroidPrivateInputScope(transport('match').adb, 'other.app'),
    undefined,
  );
});

test('transport exceptions and oversized values cannot leak sensitive messages', async () => {
  const adb: AndroidAdbExecutor = async () => {
    throw new Error('synthetic-private-value');
  };
  const result = await compareAndroidPrivateInput(adb, bound, 'synthetic-private-value');
  assert.deepEqual(result, { status: 'unknown', reason: 'comparison_unavailable' });
  assert.equal(
    (await compareAndroidPrivateInput(adb, bound, 'x'.repeat(16_001))).status,
    'unknown',
  );
});
