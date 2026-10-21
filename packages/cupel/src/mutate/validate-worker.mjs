// Validity check worker (D6): run as `node --experimental-vm-modules validate-worker.mjs`.
// Reads a JSON array of { mode: 'module' | 'commonjs', text } on standard input and writes a JSON array of
// null (parses) or the SyntaxError message, in the same order. It only parses: nothing is linked or run.

import { parseErrors } from './validity.mjs';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify(parseErrors(JSON.parse(data))));
});
