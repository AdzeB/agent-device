import { describe, expect, it } from 'vitest';
import {
  consumePrivateFieldComparison,
  hasOutgoingPrivateFieldComparison,
  parsePrivateFieldComparison,
  serializePrivateSocketRequest,
  withOutgoingPrivateFieldComparison,
  withPrivateFieldComparison,
} from './private-field-comparison.ts';

const payload = {
  protocol: 'android-private-input-v1' as const,
  requestId: '12345678-1234-1234-1234-123456789abc',
  expectedValue: 'private-fixture-value',
};

describe('private comparison scope', () => {
  it('adds private input only at final serialization and consumes it once', async () => {
    const request = { command: 'get', positionals: ['attrs', '@e1~s2'] };
    await withOutgoingPrivateFieldComparison(payload, async () => {
      expect(JSON.stringify(request)).not.toContain(payload.expectedValue);
      expect(JSON.parse(serializePrivateSocketRequest(request)).privateFieldComparison).toEqual(
        payload,
      );
      expect(() => serializePrivateSocketRequest(request)).toThrow();
    });
    expect(hasOutgoingPrivateFieldComparison()).toBe(false);
  });
  it('isolates concurrent scopes even with identical caller IDs', async () => {
    await Promise.all(
      ['one', 'two'].map(async (expectedValue) => {
        await withPrivateFieldComparison({ ...payload, expectedValue }, async () => {
          await Promise.resolve();
          expect(consumePrivateFieldComparison()?.expectedValue).toBe(expectedValue);
          expect(() => consumePrivateFieldComparison()).toThrow();
        });
      }),
    );
    expect(consumePrivateFieldComparison()).toBeUndefined();
  });
  it('cleans scope after exceptions and leaves ordinary requests unaffected', async () => {
    await expect(
      withPrivateFieldComparison(payload, async () => {
        throw new Error('fixture');
      }),
    ).rejects.toThrow('fixture');
    await withPrivateFieldComparison(undefined, async () => {
      expect(consumePrivateFieldComparison()).toBeUndefined();
    });
  });
  it('rejects extra keys and oversized values without echoing input', () => {
    for (const value of [
      { ...payload, extra: 'secret' },
      { ...payload, expectedValue: 'x'.repeat(16385) },
    ]) {
      expect(() => parsePrivateFieldComparison(value)).toThrow(
        'Invalid private comparison payload',
      );
    }
  });
});
