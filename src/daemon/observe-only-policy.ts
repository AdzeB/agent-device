import { AppError } from '@agent-device/kernel/errors';
import { checkFindArgs, isReadOnlyFindAction } from '@agent-device/selectors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import type { InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import { errorResponse } from './response.ts';
import type { DeviceLease } from '@agent-device/contracts/device';

export function requireObserveOnlyLease(lease: DeviceLease | undefined): DeviceLease {
  if (lease) return lease;
  throw new AppError('COMMAND_FAILED', '--observe-only cannot read an expired session.', {
    observation: {
      mode: 'observe-only',
      capability: 'non-activating-foreground-v1',
      foregroundVerified: false,
      reason: 'session_expired',
    },
  });
}

export function observeOnlyCommandResponse(req: DaemonRequest): DaemonResponse | undefined {
  if (req.flags?.observeOnly !== true) return undefined;
  const allowed =
    req.command === 'snapshot' ||
    req.command === 'get' ||
    req.command === 'is' ||
    (req.command === 'find' && readOnlyFind(req));
  if (!allowed)
    return observeOnlyRefusal(
      'unsupported_command',
      '--observe-only requires snapshot, get, is, or an explicit read-only find action.',
    );
  if (req.command === 'get' && req.positionals?.[1]?.startsWith('@')) {
    return observeOnlyRefusal(
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
    return observeOnlyRefusal(
      'target_identity_missing',
      '--observe-only requires an existing app session with an explicit target identity.',
    );
  }
  if (session.device.platform !== 'apple' || session.device.appleOs === 'watchos') {
    return observeOnlyRefusal(
      'unsupported_platform',
      '--observe-only is supported only by the local Apple runner.',
    );
  }
  if (session.surface !== undefined && session.surface !== 'app') {
    return observeOnlyRefusal('unsupported_surface', '--observe-only requires an app surface.');
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
        {
          observation: {
            mode: 'observe-only',
            foregroundVerified: false,
            reason: 'unsupported_runtime',
          },
        },
      );
    }
    return facts;
  };
}

export function withObserveOnlyEvidence(
  response: DaemonResponse,
  snapshot: Pick<SnapshotState, 'observation'> | undefined,
): DaemonResponse {
  if (!snapshot?.observation) return response;
  if (response.ok)
    return { ...response, data: { ...response.data, observation: snapshot.observation } };
  if (response.error.details?.observation) return response;
  return {
    ...response,
    error: {
      ...response.error,
      details: { ...response.error.details, observation: snapshot.observation },
    },
  };
}

function readOnlyFind(req: DaemonRequest): boolean {
  const checked = checkFindArgs(req.positionals ?? [], req.flags);
  return checked.ok && isReadOnlyFindAction(checked.parsed.action);
}

function observeOnlyRefusal(reason: string, message: string): DaemonResponse {
  return errorResponse('INVALID_ARGS', message, {
    observation: {
      mode: 'observe-only',
      capability: 'non-activating-foreground-v1',
      foregroundVerified: false,
      reason,
    },
  });
}
