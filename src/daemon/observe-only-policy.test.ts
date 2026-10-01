import assert from 'node:assert/strict';
import { test } from 'vitest';
import { observeOnlyCommandResponse, requireObserveOnlyLease } from './observe-only-policy.ts';
import { AppError } from '@agent-device/kernel/errors';

function refusal(command: string, positionals: string[], flags: Record<string, unknown> = {}) {
  return observeOnlyCommandResponse({
    command,
    positionals,
    token: 't',
    session: 'qa',
    flags: { observeOnly: true, ...flags },
  });
}

test('observe-only admits reads only and refuses with a non-activation block', () => {
  assert.equal(refusal('snapshot', []), undefined);
  assert.equal(refusal('screenshot', [], { screenshotStream: true }), undefined);
  assert.equal(refusal('find', ['Confirmation', 'exists']), undefined);
  for (const [command, positionals] of [
    ['press', ['@e1']],
    ['find', ['Confirmation']],
    ['screenshot', []],
    ['get', ['text', '@e1']],
  ] as const) {
    const response = refusal(command, [...positionals]);
    assert.ok(response && !response.ok, `${command} ${positionals.join(' ')}`);
    const observation = response.error.details?.observation as Record<string, unknown>;
    assert.equal(observation.foregroundVerified, false);
    assert.equal(observation.activationPerformed, false);
  }
});

test('F8: an expired lease is refused rather than renewed', () => {
  assert.throws(
    () => requireObserveOnlyLease(undefined),
    (error: unknown) => {
      const observation = error instanceof AppError ? error.details?.observation : undefined;
      return (observation as { reason?: string } | undefined)?.reason === 'session_expired';
    },
  );
});
