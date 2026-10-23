import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { resolveLocalDaemonCodeIdentity } from './daemon-launch-spec.ts';

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
