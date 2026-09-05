import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { readPrivateFieldEvidence } from '@agent-device/contracts/element-text-runtime';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { finishPrivateFieldCapture } from './private-field-capture.ts';
import { parseUiHierarchyTree } from './ui-hierarchy.ts';
import type { AndroidAdbExecutor } from './adb-transport.ts';

const mocks = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('./private-input-comparison.ts', () => ({
  acquireAndroidPrivateInputScope: mocks.acquire,
}));
const scope = { appId: 'example.app', fieldId: 3, connectionToken: 'original' };
const tree = parseUiHierarchyTree(
  '<hierarchy><node window-index="0" window-type="1" window-active="true" window-focused="true"><node class="android.widget.EditText" package="example.app" window-id="7" bounds="[10,20][110,50]" editable="true" focused="true" /></node></hierarchy>',
);
const adb: AndroidAdbExecutor = async () => ({ stdout: '', stderr: '', exitCode: 0 });

test('only unchanged complete capture brackets retain private scope on issued refs', async () => {
  for (const changed of [false, true]) {
    const node: RawSnapshotNode = {
      index: 1,
      type: 'android.widget.EditText',
      editable: true,
      focused: true,
      rect: { x: 10, y: 20, width: 100, height: 30 },
    };
    mocks.acquire.mockResolvedValue({
      ...scope,
      connectionToken: changed ? 'replacement' : scope.connectionToken,
    });
    const signal = new AbortController().signal;
    await finishPrivateFieldCapture({
      adb,
      scope,
      signal,
      nodes: [node],
      tree,
      metadata: { backend: 'android-helper', helperTruncated: false, rootPresent: true },
    });
    const issued = attachRefs([node])[0]!;
    assert.equal(
      readPrivateFieldEvidence(issued)?.connectionToken,
      changed ? undefined : 'original',
    );
    assert.equal(JSON.stringify(issued).includes('original'), false);
    const options = mocks.acquire.mock.calls.at(-1)![2];
    assert.equal(options.timeoutMs, 3000);
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('partial capture cannot mint private scope evidence', async () => {
  mocks.acquire.mockClear();
  await finishPrivateFieldCapture({
    adb,
    scope,
    nodes: [],
    tree,
    metadata: { backend: 'android-helper', helperTruncated: true, rootPresent: true },
  });
  assert.equal(mocks.acquire.mock.calls.length, 0);
});
