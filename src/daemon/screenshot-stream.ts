import { AppError } from '@agent-device/kernel/errors';
import type { NativePngStream } from '@agent-device/contracts/screenshot-runtime';
import type { DaemonRequest, SessionState } from './types.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import {
  resolveBoundScreenshotRuntime,
  type ScreenshotRuntimeBindings,
} from './screenshot-runtime-binding.ts';
import { observeOnlyRuntimeFacts, observeOnlySessionResponse } from './observe-only-policy.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import { readSessionRuntimeRevision } from './ref-frame.ts';

export async function resolveScreenshotStream(
  params: Readonly<{ req: DaemonRequest; session: SessionState }> & ScreenshotRuntimeBindings,
): Promise<ResolvedGenericExecution> {
  const { req, session } = params;
  if (
    req.flags?.observeOnly !== true ||
    req.positionals?.length ||
    req.flags.out ||
    req.flags.overlayRefs ||
    req.flags.screenshotCropOn ||
    req.flags.screenshotFullscreen ||
    req.flags.screenshotScale !== undefined ||
    req.flags.screenshotPixelDensity !== undefined ||
    req.flags.screenshotNormalizeStatusBar ||
    req.flags.settle ||
    session.trace
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Memory screenshot requires --observe-only without file, trace, settle, or postprocessing options',
    );
  }
  const invalid = observeOnlySessionResponse(req, session);
  if (invalid) return { ok: false, response: invalid };
  const bound = await resolveBoundScreenshotRuntime({
    ...params,
    device: session.device,
    overlayRefs: false,
    inspectFacts: observeOnlyRuntimeFacts(true, params.inspectFacts),
  });
  if (!bound.ok) return bound;
  return {
    ok: true,
    execute: async (execution) => {
      const revision = readSessionRuntimeRevision(session);
      let captured: NativePngStream | undefined;
      await bound.runtime.captureScreenshot({
        options: { appBundleId: session.appBundleId },
        execution: runtimeExecutionFromContext(execution.dispatchContext),
        consumePng: (image) => {
          captured = image;
        },
      });
      if (!captured || readSessionRuntimeRevision(session) !== revision) {
        throw new AppError('COMMAND_FAILED', 'Memory screenshot session changed');
      }
      return {
        ...captured,
        appBundleId: session.appBundleId,
        sessionName: execution.sessionName,
        sessionRevision: revision,
      };
    },
  };
}
