import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { makeAndroidSession } from '../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../__tests__/test-utils/store-factory.ts';
import { selectorCaptureFixture } from './__tests__/selector-capture-fixture.ts';
import { activateCompleteRefFrame } from './ref-frame.ts';
import { dispatchGetViaRuntime } from './selector-runtime.ts';
import { withPrivateFieldComparison } from './private-field-comparison.ts';

test('private get route resolves a real @ref generation through the owned frame', async () => {
  for (const ref of ['@e1~s7', '@e1~s6']) {
    const appId = 'example.app';
    const tree: SnapshotState = {
      backend: 'android',
      producer: 'android-uiautomator',
      createdAt: 1,
      nodes: [{ index: 0, ref: 'e1', bundleId: appId, editable: true, focused: true }],
    };
    const session = makeAndroidSession('private-field-test', {
      appBundleId: appId,
      snapshot: tree,
      snapshotGeneration: 7,
    });
    activateCompleteRefFrame(session);
    const sessionStore = makeSessionStore();
    sessionStore.set(session.name, session);
    let compared = false;
    const fixture = selectorCaptureFixture({
      comparePrivateField: async (input) => {
        compared = true;
        assert.equal(input.target, tree.nodes[0]);
        assert.equal(input.expectedValue, 'synthetic-private');
        return {
          status: 'match',
          source: 'android-ime-extracted-text',
          appId,
          fieldId: 3,
          connectionToken: '01234567-0123-0123-0123-012345678901:1',
        };
      },
    });
    const response = await withPrivateFieldComparison(
      {
        protocol: 'android-private-input-v1',
        requestId: '01234567-0123-0123-0123-012345678901',
        expectedValue: 'synthetic-private',
      },
      () =>
        dispatchGetViaRuntime({
          req: {
            command: 'get',
            positionals: ['attrs', ref],
            token: 'test',
            session: session.name,
          },
          sessionName: session.name,
          sessionStore,
          inspectFacts: fixture.inspectFacts,
          bindDevice: fixture.bindDevice,
        }),
    );
    assert.equal(response?.ok, true);
    if (!response?.ok) throw new Error('Expected private result');
    assert.equal(response.data?.status, ref === '@e1~s7' ? 'match' : 'unknown');
    assert.equal(compared, ref === '@e1~s7');
    assert.equal(JSON.stringify(response).includes('synthetic-private'), false);
  }
});
