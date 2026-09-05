import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import type { AndroidUiHierarchy } from './ui-hierarchy.ts';

export function resolveFocusedPrivateTarget(
  tree: AndroidUiHierarchy,
  input: { target: RawSnapshotNode; appId: string; windowId?: number },
): AndroidUiHierarchy | undefined {
  const { target } = input;
  const rect = target.rect;
  if (!rect || target.editable !== true || target.focused !== true) return undefined;
  const matches: AndroidUiHierarchy[] = [];
  const focused: AndroidUiHierarchy[] = [];
  function visit(node: AndroidUiHierarchy, window?: AndroidUiHierarchy) {
    const owner = node.windowIndex !== undefined ? node : window;
    if (node.focused === true && node.editable === true) focused.push(node);
    if (
      matchesIdentity(node, input) &&
      matchesRect(node.rect, rect!) &&
      isAvailableInput(node) &&
      isFocusedApplicationWindow(owner)
    )
      matches.push(node);
    for (const child of node.children) visit(child, owner);
  }
  visit(tree);
  return matches.length === 1 && focused.length === 1 && matches[0] === focused[0]
    ? matches[0]
    : undefined;
}

function matchesIdentity(
  node: AndroidUiHierarchy,
  input: { target: RawSnapshotNode; appId: string; windowId?: number },
): boolean {
  return (
    node.packageName === input.appId &&
    node.type === input.target.type &&
    (node.identifier ?? '') === (input.target.identifier ?? '') &&
    node.windowId !== undefined &&
    (input.windowId === undefined || input.windowId === node.windowId)
  );
}

function matchesRect(actual: Rect | undefined, expected: Rect): boolean {
  return (
    actual !== undefined &&
    actual.x === expected.x &&
    actual.y === expected.y &&
    actual.width === expected.width &&
    actual.height === expected.height
  );
}

function isAvailableInput(node: AndroidUiHierarchy): boolean {
  return node.editable === true && node.enabled !== false && node.visibleToUser !== false;
}

function isFocusedApplicationWindow(window: AndroidUiHierarchy | undefined): boolean {
  return window?.windowActive === true && window.windowFocused === true && window.windowType === 1;
}
