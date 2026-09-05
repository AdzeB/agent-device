import { createHash } from 'node:crypto';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  PostActionResponse,
  PostActionResponseFrame,
} from '@agent-device/contracts/interaction';
import { formatRole } from '../../../snapshot/snapshot-lines.ts';

const MAX_FRAMES = 4;
const MAX_NODES = 256;
const MAX_FRAME_BYTES = 16_384;
type ResponseNode = PostActionResponseFrame['snapshot']['nodes'][number];

/** Retains existing captures only; it neither observes the device nor updates the ref frame. */
export function createPostActionResponseCollector() {
  const response: PostActionResponse = { frames: [], omittedFrames: 0 };
  let previousDigest: string | undefined;
  return {
    response,
    capture(nodes: SnapshotNode[], capturedAt: number) {
      const { frame, digest } = projectResponseFrame(nodes, capturedAt);
      if (digest === previousDigest) return;
      previousDigest = digest;
      if (response.frames.length >= MAX_FRAMES) {
        response.omittedFrames += 1;
        return;
      }
      response.frames.push(frame);
    },
  };
}

function projectResponseFrame(nodes: SnapshotNode[], capturedAt: number) {
  const hiddenLabels = privateLabelIndexes(nodes);
  const frame: PostActionResponseFrame = { capturedAt, snapshot: { nodes: [] }, truncated: false };
  let bytes = Buffer.byteLength(JSON.stringify(frame));
  const digest = createHash('sha256');
  for (const node of nodes) {
    const projected = projectResponseNode(node, hiddenLabels);
    const serialized = JSON.stringify(projected);
    digest.update(serialized).update('\n');
    const nodeBytes = Buffer.byteLength(serialized) + Number(frame.snapshot.nodes.length > 0);
    if (frame.snapshot.nodes.length >= MAX_NODES || bytes + nodeBytes > MAX_FRAME_BYTES) {
      frame.truncated = true;
      continue;
    }
    frame.snapshot.nodes.push(projected);
    bytes += nodeBytes;
  }
  return { frame, digest: digest.digest('hex') };
}

function projectResponseNode(node: SnapshotNode, hiddenLabels: Set<number>): ResponseNode {
  const projected: ResponseNode = {};
  if (node.type !== undefined) projected.type = node.type;
  if (!hiddenLabels.has(node.index)) projected.label = node.label;
  if (node.identifier !== undefined) projected.identifier = node.identifier;
  return projected;
}

function responseParents(nodes: SnapshotNode[]): Map<number, number | undefined> {
  const parents = new Map<number, number | undefined>();
  const ancestry: SnapshotNode[] = [];
  for (const node of nodes) {
    while (ancestry.length && (ancestry.at(-1)!.depth ?? 0) >= (node.depth ?? 0)) ancestry.pop();
    parents.set(node.index, node.parentIndex ?? ancestry.at(-1)?.index);
    ancestry.push(node);
  }
  return parents;
}

function* ancestorIndexes(index: number, parents: Map<number, number | undefined>) {
  const visited = new Set<number>();
  let current: number | undefined = index;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    yield current;
    current = parents.get(current);
  }
}

function privateLabelIndexes(nodes: SnapshotNode[]): Set<number> {
  const parents = responseParents(nodes);
  const editableRoots = new Set(nodes.filter(isPrivateInput).map((node) => node.index));
  const hidden = new Set<number>();
  for (const index of editableRoots) {
    for (const ancestor of ancestorIndexes(index, parents)) hidden.add(ancestor);
  }
  // Some native controls expose the entered text as a static child of the editable container.
  for (const node of nodes) {
    for (const ancestor of ancestorIndexes(node.index, parents)) {
      if (!editableRoots.has(ancestor)) continue;
      hidden.add(node.index);
      break;
    }
  }
  return hidden;
}

function isPrivateInput(node: SnapshotNode): boolean {
  if (node.editable === true || node.password === true) return true;
  return [node.type, node.role, node.subrole].some(isPrivateRole);
}

function isPrivateRole(role: string | undefined): boolean {
  if (!role) return false;
  return (
    ['text-field', 'text-view', 'search'].includes(formatRole(role)) ||
    /secure|password/i.test(role)
  );
}
