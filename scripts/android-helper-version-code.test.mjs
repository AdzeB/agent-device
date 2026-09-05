import assert from 'node:assert/strict';
import { test } from 'node:test';
import { androidHelperVersionCode } from './android-helper-version-code.mjs';

for (const version of ['0.20.11', '0.20.11-a2', '0.20.11-alpha.2+build.7', '0.20.11+build.7']) {
  test(`helper version ${version} retains its semver core code`, () => {
    assert.equal(androidHelperVersionCode(version), 20011);
  });
}

for (const version of [
  '',
  'dev',
  'v0.20.11',
  '00.20.11',
  '0.20.11-01',
  '0.20.11+',
  '0.1000.0',
  '0.0.0',
  '2148.0.0',
]) {
  test(`invalid or unrepresentable helper version ${version} is rejected`, () => {
    assert.throws(() => androidHelperVersionCode(version));
  });
}
