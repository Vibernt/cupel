import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inputIdentity } from '../../analysis/assertions.mjs';
import { DEFAULT_CAP } from './recorder.mjs';
export function writeAssertions(out, input, tests, cap = DEFAULT_CAP) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version: 'cupel-assertions/1', cap, inputIdentity: inputIdentity(input),
    tests: Object.fromEntries([...tests].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }, null, 2) + '\n');
}
