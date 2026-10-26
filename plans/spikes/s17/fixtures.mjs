import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject } from '../../../packages/cupel/test/mutate-helpers.mjs';

export const jestFixture = new URL('../../../spec/conformance/adapters/jest/', import.meta.url).pathname;

export function nodeFixture() {
  const p = makeProject();
  return { root: p.root, input: p.input, cleanup: p.cleanup,
    options: { scope: { changed: { 'src/calc.mjs': '2-3' } },
      config: { mutation: { maxMutants: 6, maxSeconds: 60, seed: 17 } } } };
}

export function sourceHeavyFixture(root, count = 700) {
  if (!Number.isInteger(count) || count < 100 || count > 2000) throw new Error('invalid source-heavy size');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  const lines = ['export function lookup(x) {'];
  for (let i = 0; i < count; i++) lines.push(`  if (x === ${i}) return ${i + 1};`);
  lines.push('  return -1;', '}');
  writeFileSync(join(root, 'src/lookup.mjs'), `${lines.join('\n')}\n`);
  const names = ['first', 'middle', 'last'];
  const values = [0, Math.floor(count / 2), count - 1];
  const tests = names.map((name, i) => ({ id: `tests/lookup.test.mjs::${name}`, file: 'tests/lookup.test.mjs',
    name, status: 'passed', durationsMs: [5, 5] }));
  const testSource = ["import { test } from 'node:test';", "import assert from 'node:assert/strict';",
    "import { lookup } from '../src/lookup.mjs';",
    ...names.map((name, i) => `test('${name}', () => assert.equal(lookup(${values[i]}), ${values[i] + 1}));`)];
  writeFileSync(join(root, 'tests/lookup.test.mjs'), `${testSource.join('\n')}\n`);
  const input = { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: process.versions.node },
    sources: { 'src/lookup.mjs': { coverable: `1-${count + 3}` } }, tests,
    coverage: { granularity: 'test', byTest: Object.fromEntries(tests.map(t =>
      [t.id, { 'src/lookup.mjs': `1-${count + 3}` }])),
      setup: { 'tests/lookup.test.mjs': { 'src/lookup.mjs': '1' } } } };
  return { root, input, options: { scope: { changed: { 'src/lookup.mjs': `2-${count + 1}` } },
    config: { mutation: { maxMutants: 8, maxSeconds: 60, seed: 17 } } },
    metadata: { type: 'synthetic', sourceLines: lines.length, tests: tests.length,
      sourceBytes: Buffer.byteLength(readFileSync(join(root, 'src/lookup.mjs'))) } };
}
