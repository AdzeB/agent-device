import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { resolveLocalDaemonCodeIdentity } from './daemon-launch-spec.ts';

/**
 * Private reads go only to a daemon running this client's own code: the same version, the same
 * code origin, and — for a source checkout, whose code moves under a fixed version — the same
 * code signature. An installed tree is identified by its version, as daemon reuse does.
 */
export async function requirePrivateFieldDaemonIdentity(info: DaemonInfo): Promise<void> {
  if (info.version !== readVersion()) throw unverified();
  const local = await resolveLocalDaemonCodeIdentity();
  if (info.codeOrigin !== undefined && info.codeOrigin !== local.origin) throw unverified();
  if (local.origin === 'installed') return;
  if (!info.codeSignature || info.codeSignature !== local.codeSignature) throw unverified();
}

function unverified(): AppError {
  return new AppError('COMMAND_FAILED', 'Private comparison requires a verified current daemon');
}
