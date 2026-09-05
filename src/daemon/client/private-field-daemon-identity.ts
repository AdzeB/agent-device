import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { resolveLocalDaemonCodeSignature } from './daemon-launch-spec.ts';

export async function requirePrivateFieldDaemonIdentity(info: DaemonInfo): Promise<void> {
  if (info.version !== readVersion()) throw unverified();
  if (!info.codeSignature || info.codeSignature === 'unknown') throw unverified();
  const signature = await resolveLocalDaemonCodeSignature();
  if (signature === 'unknown' || signature !== info.codeSignature) throw unverified();
}

function unverified(): AppError {
  return new AppError('COMMAND_FAILED', 'Private comparison requires a verified current daemon');
}
