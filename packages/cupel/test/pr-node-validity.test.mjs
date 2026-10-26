import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileCandidateValidity } from '../src/pr/profiles/node/validity.mjs';

const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';

test('fixed Node 26 validity worker distinguishes valid and invalid CommonJS, ESM and erasable TS', () => {
  const result = profileCandidateValidity([
    { mutant: { source: 'src/a.cjs', mode: 'commonjs' }, text: 'module.exports = 1;' },
    { mutant: { source: 'src/b.mjs', mode: 'module' }, text: 'export const value = ;' },
    { mutant: { source: 'src/c.ts', mode: 'typescript' },
      text: 'export const value: number = 1;' },
  ], nodePath);
  assert.deepEqual(result.map(row => row.valid), [true, false, true]);
  assert.match(result[1].error, /^SyntaxError:/);
});

test('fixed validity worker refuses unsupported JSX and a failed worker', () => {
  assert.throws(() => profileCandidateValidity([
    { mutant: { source: 'src/a.tsx', mode: 'jsx' }, text: '<div />' },
  ], nodePath), /cannot parse JSX/);
  assert.throws(() => profileCandidateValidity([
    { mutant: { source: 'src/a.cjs', mode: 'commonjs' }, text: 'module.exports = 1;' },
  ], '/no/such/node'), /fixed validity worker failed/);
});
