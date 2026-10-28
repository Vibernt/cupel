import { usage } from './errors.mjs';

const VALUES = new Set(['--test-concurrency', '--test-timeout', '--test-reporter', '--test-reporter-destination',
  '--import', '--require', '--conditions', '--env-file', '--env-file-if-exists',
  '--disable-warning', '--max-old-space-size', '--stack-size']);
const SWITCHES = new Set(['--test-force-exit', '--enable-source-maps', '--experimental-strip-types',
  '--experimental-transform-types', '--no-experimental-strip-types', '--no-warnings',
  '--experimental-vm-modules', '--experimental-test-module-mocks', '--experimental-test-snapshots',
  '--test-update-snapshots']);
const FORBIDDEN = new Map([
  ['--test-name-pattern', 'filters tests and makes collection incomplete'],
  ['--test-skip-pattern', 'filters tests and makes collection incomplete'],
  ['--test-only', 'filters tests and makes collection incomplete'],
  ['--test-shard', 'use cupel --shard instead'],
  ['--test-isolation', 'changes collection process boundaries'],
  ['--experimental-test-isolation', 'changes collection process boundaries'],
]);

export function nodeFlags(args) {
  const out = [];
  let reporters = 0, destinations = 0;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw.startsWith('-')) throw usage(`positional test file ${JSON.stringify(raw)} is refused; use --tests`);
    const flag = { '-r': '--require', '-C': '--conditions' }[raw.split('=')[0]] ?? raw.split('=')[0];
    if (FORBIDDEN.has(flag)) throw usage(`${flag}: ${FORBIDDEN.get(flag)}`);
    if (flag.startsWith('--watch') || flag.startsWith('--inspect') || flag === '--experimental-test-coverage' || flag.startsWith('--test-coverage-'))
      throw usage(`${flag}: changes or exposes the test run; collection requires a complete ordinary run`);
    if (!VALUES.has(flag) && !SWITCHES.has(flag)) throw usage(`${flag}: flag is not allowed for collect-node`);
    if (VALUES.has(flag)) {
      const equals = raw.includes('=');
      const value = equals ? raw.slice(raw.indexOf('=') + 1) : args[++i];
      if (!value || (!equals && value.startsWith('-'))) throw usage(`${flag} needs a value`);
      out.push(`${flag}=${value}`);
    } else {
      if (raw !== flag) throw usage(`${flag} does not accept a value`);
      out.push(flag);
    }
    if (flag === '--test-reporter') reporters++;
    if (flag === '--test-reporter-destination') destinations++;
  }
  if (reporters !== destinations) throw usage('--test-reporter and --test-reporter-destination must occur in equal numbers');
  return out;
}
