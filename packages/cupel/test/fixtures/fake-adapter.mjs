// Test-only adapter for `cupel conformance`: prints the fixture's expected.json (in the current
// directory) as a complete input. With the argument `broken`, it drops the last test.
import { readFileSync } from 'node:fs';

const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '$absent').map(([k, x]) => [k, strip(x)]));
  }
  return v;
};
const input = strip(JSON.parse(readFileSync('expected.json', 'utf8')));
input.runtime.version ??= '0.0.0';
if (process.argv[2] === 'broken') input.tests.pop();
process.stdout.write(JSON.stringify(input));
