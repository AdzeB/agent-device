import type { Readable } from 'node:stream';
import { AppError } from '@agent-device/kernel/errors';
import {
  parsePrivateFieldComparison,
  PRIVATE_COMPARISON_MAX_BYTES,
  withOutgoingPrivateFieldComparison,
} from '../daemon/private-field-comparison.ts';

export function privateComparisonArgs(argv: string[]): string[] {
  const separator = argv.indexOf('--');
  const flags = parseComparisonFlags(argv.slice(1, separator));
  validateComparisonFlags(flags);
  const session = requiredPattern(flags.get('--session'), /^[A-Za-z0-9_.-]{1,128}$/);
  const ref = requiredPattern(argv[separator + 1], /^@e\d+~s\d+$/);
  if (separator < 1 || separator + 2 !== argv.length) throw invalidArgs();
  return ['get', 'attrs', '--json', '--platform', 'android', '--session', session, '--', ref];
}

function parseComparisonFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) throw invalidArgs();
    if (flags.has(flag)) throw invalidArgs();
    if (['--private-stdin', '--json'].includes(flag)) flags.set(flag, true);
    else if (['--platform', '--session'].includes(flag)) {
      flags.set(flag, requiredPattern(argv[++index], /^(?!--).+$/));
    } else throw invalidArgs();
  }
  return flags;
}

function requiredPattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalidArgs();
  return value;
}

function validateComparisonFlags(flags: Map<string, string | true>): void {
  if (
    flags.size !== 4 ||
    flags.get('--platform') !== 'android' ||
    flags.get('--private-stdin') !== true ||
    flags.get('--json') !== true
  )
    throw invalidArgs();
}

function invalidArgs(): AppError {
  return new AppError(
    'INVALID_ARGS',
    'Usage: compare-field --private-stdin --json --platform android --session NAME -- @eN~sG',
  );
}

export async function runPrivateFieldComparison(
  argv: string[],
  run: (args: string[]) => Promise<void>,
  input: Readable = process.stdin,
): Promise<void> {
  const args = privateComparisonArgs(argv);
  let body = '';
  let bytes = 0;
  input.setEncoding('utf8');
  const timer = setTimeout(
    () => input.destroy(new AppError('INVALID_ARGS', 'Private comparison input timed out')),
    10_000,
  );
  timer.unref();
  try {
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > PRIVATE_COMPARISON_MAX_BYTES)
        throw new AppError('INVALID_ARGS', 'Private comparison input is too large');
      body += chunk.toString();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new AppError('INVALID_ARGS', 'Invalid private comparison payload');
    }
    body = '';
    const payload = parsePrivateFieldComparison(parsed);
    await withOutgoingPrivateFieldComparison(payload, async () => await run(args));
  } finally {
    clearTimeout(timer);
    body = '';
  }
}
