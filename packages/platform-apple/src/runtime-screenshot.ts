import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  bindLocalScreenshotInteractor,
  type ScreenshotRuntimeOperations,
} from '@agent-device/contracts/screenshot-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { runAppleRunnerCommand } from './runner/runner-client.ts';
import { getReadyRunnerSession } from './runner/runner-session.ts';
import { readObserveOnlyEvidence } from '@agent-device/contracts/capture';

export function bindAppleScreenshotRuntime(
  host: PlatformRuntimeHost,
  request: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
): ScreenshotRuntimeOperations {
  const files = bindLocalScreenshotInteractor({
    ...request,
    resolveInteractor: host.localInteractors.resolve,
  });
  return {
    captureScreenshot: async (input) => {
      if (!input.consumePng) return await files.captureScreenshot(input);
      const appBundleId = input.options?.appBundleId;
      const session = getReadyRunnerSession(request.device.id);
      if (request.device.appleOs !== 'ios' || !appBundleId || !session || input.outPath) {
        throw unavailable();
      }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
      try {
        signal.throwIfAborted();
        if (session.logicalLeaseContext?.leaseId !== input.execution?.runnerLeaseContext?.leaseId)
          throw unavailable();
        const data = await runAppleRunnerCommand(
          request.device,
          {
            command: 'screenshot',
            appBundleId,
            inlineScreenshot: true,
            observeOnly: true,
          },
          {
            ...input.execution,
            signal,
            expectedRunnerSessionId: session.sessionId,
          },
        );
        signal.throwIfAborted();
        if (getReadyRunnerSession(request.device.id) !== session) throw unavailable();
        const observation = readObserveOnlyEvidence(data.observation);
        const encoded = data.imageBase64;
        if (
          !observation ||
          observation.targetAppBundleId !== appBundleId ||
          typeof encoded !== 'string' ||
          encoded.length > 16 * 1024 * 1024 - 8192 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
        )
          throw unavailable();
        const bytes = Buffer.from(encoded, 'base64');
        if (
          bytes.length < 24 ||
          bytes.toString('base64') !== encoded ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.readUInt32BE(16) === 0 ||
          bytes.readUInt32BE(20) === 0
        )
          throw unavailable();
        bytes.fill(0);
        input.consumePng({
          protocol: 'native-png-stream-v1',
          mimeType: 'image/png',
          imageBase64: encoded,
          runnerSessionId: session.sessionId,
          observation: { ...observation },
        });
      } catch {
        throw unavailable();
      }
    },
  };
}

function unavailable(): AppError {
  return new AppError('COMMAND_FAILED', 'Session-bound memory screenshot unavailable');
}
