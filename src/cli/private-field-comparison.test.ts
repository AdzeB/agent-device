import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { privateComparisonArgs, runPrivateFieldComparison } from './private-field-comparison.ts';

const scopes = vi.hoisted(() => [] as unknown[]);
vi.mock('@agent-device/daemon-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/daemon-client')>();
  return {
    ...original,
    withOutgoingPrivateFieldComparison: <T>(payload: unknown, run: () => Promise<T>) => {
      scopes.push(payload);
      return original.withOutgoingPrivateFieldComparison(
        payload as Parameters<typeof original.withOutgoingPrivateFieldComparison>[0],
        run,
      );
    },
  };
});

const args = [
  'compare-field',
  '--private-stdin',
  '--json',
  '--platform',
  'android',
  '--session',
  'qa',
  '--',
  '@e1~s2',
];
it('maps only explicit Android versioned-ref requests', () => {
  expect(privateComparisonArgs(args)).toEqual([
    'get',
    'attrs',
    '--json',
    '--platform',
    'android',
    '--session',
    'qa',
    '--',
    '@e1~s2',
  ]);
  for (const argv of [
    args.slice(0, -1),
    [...args, 'unexpected'],
    args.map((a) => (a === 'android' ? 'ios' : a)),
    args.map((a) => (a === '@e1~s2' ? '@e1' : a)),
  ]) {
    expect(() => privateComparisonArgs(argv)).toThrow();
  }
});
it('keeps input out of translated argv and preserves Unicode', async () => {
  const payload = {
    protocol: 'android-private-input-v1',
    requestId: '12345678-1234-1234-1234-123456789abc',
    expectedValue: 'é🔒fixture',
  };
  const body = Buffer.from(JSON.stringify(payload));
  await runPrivateFieldComparison(
    args,
    async (translated) => {
      expect(JSON.stringify(translated)).not.toContain(payload.expectedValue);
      expect(scopes).toEqual([payload]);
    },
    Readable.from([body.subarray(0, body.length - 8), body.subarray(body.length - 8)]),
  );
});
it('never echoes malformed input in errors', async () => {
  await expect(
    runPrivateFieldComparison(args, async () => {}, Readable.from(['secret malformed input'])),
  ).rejects.toThrow('Invalid private comparison payload');
});
