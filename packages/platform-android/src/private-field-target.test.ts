import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveFocusedPrivateTarget } from './private-field-target.ts';
import { parseUiHierarchyTree } from './ui-hierarchy.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

const target: SnapshotNode = {
  index: 2,
  ref: 'e2',
  type: 'android.widget.EditText',
  rect: { x: 10, y: 20, width: 100, height: 30 },
  editable: true,
  focused: true,
};
const field =
  '<node class="android.widget.EditText" package="example.app" window-id="7" bounds="[10,20][110,50]" editable="true" focused="true" />';
function hierarchy(
  nodes = field,
  window = 'window-active="true" window-focused="true" window-type="1"',
) {
  return parseUiHierarchyTree(
    `<hierarchy><node package="example.app" window-index="0" ${window}>${nodes}</node></hierarchy>`,
  );
}

test('fresh focused unique native field binds without requiring static Android resource IDs', () => {
  assert.ok(resolveFocusedPrivateTarget(hierarchy(), { target, appId: 'example.app' }));
});

test('rejects duplicate, other app, unfocused, wrong window, and missing window provenance', () => {
  for (const tree of [
    hierarchy(field + field),
    hierarchy(field.replace('example.app', 'other.app')),
    hierarchy(field.replace('focused="true"', 'focused="false"')),
    hierarchy(field, ''),
    hierarchy(field, 'window-active="true" window-focused="false" window-type="1"'),
  ]) {
    assert.equal(resolveFocusedPrivateTarget(tree, { target, appId: 'example.app' }), undefined);
  }
});

test('rejects stale target geometry and target that was not originally focused', () => {
  assert.equal(
    resolveFocusedPrivateTarget(hierarchy(), {
      target: { ...target, focused: false },
      appId: 'example.app',
    }),
    undefined,
  );
  assert.equal(
    resolveFocusedPrivateTarget(hierarchy(), {
      target: { ...target, rect: { ...target.rect!, x: 12 } },
      appId: 'example.app',
    }),
    undefined,
  );
  assert.equal(
    resolveFocusedPrivateTarget(hierarchy(), { target, appId: 'example.app', windowId: 8 }),
    undefined,
  );
});
