import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runCliCapture } from './cli-capture.ts';

test('press --settle --json prints the daemon settle response history unchanged', async () => {
  const frame = (capturedAt: number, label: string) => ({
    capturedAt,
    snapshot: { nodes: [{ type: 'Button', label }] },
    truncated: false,
  });
  const settle = {
    settled: true,
    captures: 3,
    response: {
      frames: [
        frame(1_000, 'Pending'),
        frame(1_050, 'Request could not be completed'),
        frame(1_100, 'Ready'),
      ],
      omittedFrames: 0,
    },
  };
  const cli = await runCliCapture(['press', 'label=Continue', '--settle', '--json'], {
    defaultResponse: { ok: true, data: { settle } },
  });
  assert.equal(cli.code, null);
  assert.deepEqual(JSON.parse(cli.stdout).data.settle.response, settle.response);
});
