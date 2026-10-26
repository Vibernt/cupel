import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { generateMutants } from '../src/mutate/operators.mjs';
import { bodySites } from '../src/mutate/body-sites.mjs';
import { sourceMutants } from '../src/mutate/sites.mjs';

const js = `export function decide(x) {
  if (x > 0) return true;
  return false;
}
`;
const ts = `export function decide(x: number): boolean {
  if (x > 0) return true;
  return false;
}
`;

test('shared JavaScript lexical facts preserve every descriptor and order', () => {
  const metrics = {};
  const source = 'src/decide.mjs';
  const expected = [...generateMutants(source, js), ...bodySites(source, js)];
  assert.deepEqual(sourceMutants('.', source, js, undefined, false, metrics), expected);
  assert.equal(metrics.lexScans, 1);
  assert.equal(metrics.bracketScans, 1);
  const onlyBody = {};
  assert.deepEqual(sourceMutants('.', source, js, undefined, true, onlyBody),
    bodySites(source, js));
  assert.equal(onlyBody.lexScans, 1);
  assert.equal(onlyBody.bracketScans, 1);
});

test('TypeScript operator and original-body offsets retain separate lexical facts', () => {
  const source = 'src/decide.ts';
  const stripped = stripTypeScriptTypes(ts);
  const expected = [...generateMutants(source, stripped), ...bodySites(source, ts)]
    .map(row => ({ ...row, mode: 'typescript' }));
  const metrics = {};
  assert.deepEqual(sourceMutants('.', source, ts, undefined, false, metrics), expected);
  assert.equal(metrics.lexScans, 2);
  assert.equal(metrics.bracketScans, 2);
});
