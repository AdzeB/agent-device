import { observeOnlyRefusal } from '@agent-device/contracts/capture';
import { AppError } from '@agent-device/kernel/errors';
import { errorResponse } from '@agent-device/kernel/contracts';
import { checkFindArgs, isReadOnlyFindAction } from '@agent-device/selectors';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DaemonRequest, DaemonResponse } from './daemon-request.ts';
import type { SessionState } from './session-state.ts';
import type { InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';

function observationRefusal(reason: string) {
  return { observation: observeOnlyRefusal(reason) };
}

export function requireObserveOnlyLease(lease: DeviceLease | undefined): DeviceLease {
  if (lease) return lease;
  throw new AppError(
    'COMMAND_FAILED',
    '--observe-only cannot read an expired session.',
    observationRefusal('session_expired'),
  );
}

export function observeOnlyCommandResponse(req: DaemonRequest): DaemonResponse | undefined {
  if (req.flags?.observeOnly !== true) return undefined;
  const allowed =
    (req.command === 'screenshot' && req.flags?.screenshotStream === true) ||
    req.command === 'snapshot' ||
    req.command === 'get' ||
    req.command === 'is' ||
    (req.command === 'find' && readOnlyFind(req));
  if (!allowed)
    return refusalResponse(
      'unsupported_command',
      '--observe-only requires snapshot, get, is, or an explicit read-only find action.',
    );
  if (req.command === 'get' && req.positionals?.[1]?.startsWith('@')) {
    return refusalResponse(
      'cached_ref_unsupported',
      '--observe-only get requires a selector; capture a fresh snapshot and read with its selector instead of a cached ref.',
    );
  }
  return undefined;
}

export function observeOnlySessionResponse(
  req: DaemonRequest,
  session: SessionState | undefined,
): DaemonResponse | undefined {
  if (req.flags?.observeOnly !== true) return undefined;
  const invalidCommand = observeOnlyCommandResponse(req);
  if (invalidCommand) return invalidCommand;
  if (!session?.appBundleId?.trim()) {
    return refusalResponse(
      'target_identity_missing',
      '--observe-only requires an existing app session with an explicit target identity.',
    );
  }
  if (session.device.platform !== 'apple' || session.device.appleOs === 'watchos') {
    return refusalResponse(
      'unsupported_platform',
      '--observe-only is supported only by the local Apple runner.',
    );
  }
  if (session.surface !== undefined && session.surface !== 'app') {
    return refusalResponse('unsupported_surface', '--observe-only requires an app surface.');
  }
  return undefined;
}

export function observeOnlyRuntimeFacts(
  observeOnly: boolean | undefined,
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
): InspectDeviceRuntimeFacts | undefined {
  if (!observeOnly || !inspectFacts) return inspectFacts;
  return async (device) => {
    const facts = await inspectFacts(device);
    if (facts.device.providerMode !== 'local' || facts.device.family !== 'apple') {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        '--observe-only requires the local Apple runtime.',
        observationRefusal('unsupported_runtime'),
      );
    }
    return facts;
  };
}

function readOnlyFind(req: DaemonRequest): boolean {
  const checked = checkFindArgs(req.positionals ?? [], req.flags);
  return checked.ok && isReadOnlyFindAction(checked.parsed.action);
}

function refusalResponse(reason: string, message: string): DaemonResponse {
  return errorResponse('INVALID_ARGS', message, observationRefusal(reason));
}
