import { expect, it } from 'vitest';
import { sanitizePrivateFieldResponse } from './private-field-response.ts';

it('suppresses old daemon attrs and error details', () => {
  for (const response of [
    { ok: true as const, data: { text: 'private observed fixture' } },
    { ok: false as const, error: { code: 'COMMAND_FAILED', message: 'private observed fixture' } },
  ]) {
    const safe = sanitizePrivateFieldResponse(response);
    expect(JSON.stringify(safe)).not.toContain('private observed fixture');
    expect(safe).toMatchObject({ ok: true, data: { status: 'unknown' } });
  }
});
it('whitelists bounded native provenance and removes additional fields', () => {
  const response = sanitizePrivateFieldResponse({
    ok: true,
    data: {
      protocol: 'android-private-input-v1',
      status: 'match',
      requestId: '12345678-1234-1234-1234-123456789abc',
      sessionId: 'qa',
      ref: '@e1~s2',
      source: 'android-ime-extracted-text',
      appId: 'org.fixture',
      connectionToken: '12345678-1234-1234-1234-123456789abc:2',
      fieldId: 1,
      refsGeneration: 2,
      text: 'private observed fixture',
      expectedValue: 'private expected fixture',
    },
  });
  expect(response).toMatchObject({ ok: true, data: { status: 'match' } });
  expect(JSON.stringify(response)).not.toContain('private observed fixture');
  expect(JSON.stringify(response)).not.toContain('private expected fixture');
});
