import { pathToFileURL } from 'node:url';

export function androidHelperVersionCode(version) {
  const [major, minor, patch] = parseSemverCore(version);
  const code = major * 1000000 + minor * 1000 + patch;
  assertRepresentableCode(code, minor, patch);
  return code;
}

function parseSemverCore(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error('Android helper version must be valid SemVer');
  }
  return match.slice(1, 4).map(Number);
}

function assertRepresentableCode(code, minor, patch) {
  if (minor >= 1000 || patch >= 1000 || !isAndroidVersionCode(code)) {
    throw new Error('Android helper version cannot be represented as an Android version code');
  }
}

function isAndroidVersionCode(code) {
  return code >= 1 && code <= 2100000000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${androidHelperVersionCode(process.argv[2])}\n`);
}
