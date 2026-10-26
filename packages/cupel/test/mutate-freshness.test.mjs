import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutateNode, confirmSurvivors, generateMutants } from '../src/mutate/index.mjs';
import { SourceChangedError } from '../src/mutate/source-facts.mjs';
import { makeProject } from './mutate-helpers.mjs';

function changingTest() {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { clamp, spin } from '../src/calc.mjs';
test('clamp caps big values', () => {
  const path = new URL('../src/calc.mjs', import.meta.url);
  writeFileSync(path, ${JSON.stringify(`export function clamp(x) {\n  if (x < 10) return 10;\n  return x;\n}\n\nexport function spin(n) {\n  let i = 0;\n  while (i < n) i += 1;\n  return i;\n}\n`)});
  assert.equal(clamp(50), 10);
});
test('clamp touches small values', () => { clamp(3); });
test('spin counts up', () => { assert.equal(spin(3), 3); });
`;
}

test('unmutated baseline source write aborts mutation rather than using retained sites', async t => {
  const p = makeProject({ 'tests/calc.test.mjs': changingTest() });
  t.after(p.cleanup);
  const metrics = {};
  await assert.rejects(mutateNode({ root: p.root, input: p.input,
    scope: { changed: { 'src/calc.mjs': '2' } }, jobs: 1, metrics }), error =>
    error instanceof SourceChangedError && error.exit === 3 &&
    /src\/calc\.mjs/.test(error.message));
  assert.ok(metrics.sourceChecks > 0);
  assert.ok(metrics.factHits > 0);
});

test('confirmation creates fresh facts and aborts source write during baseline', async t => {
  const p = makeProject({ 'tests/calc.test.mjs': changingTest() });
  t.after(p.cleanup);
  const text = readFileSync(`${p.root}/src/calc.mjs`, 'utf8');
  const mutant = generateMutants('src/calc.mjs', text)
    .find(row => row.line === 2 && row.operator === 'boundary');
  const mutation = { mutants: [{ id: mutant.id, source: mutant.source,
    line: mutant.line, operator: mutant.operator, status: 'survived' }],
    targeted: [], seed: 1, sampled: false };
  await assert.rejects(confirmSurvivors({ root: p.root, input: p.input,
    mutation, ids: [mutant.id], jobs: 1 }), error =>
    error instanceof SourceChangedError && error.exit === 3);
});

test('mutant process source write aborts before its kill can be accepted', async t => {
  const original = `export function clamp(x) {\n  if (x > 10) return 10;\n  return x;\n}\n\nexport function spin(n) {\n  let i = 0;\n  while (i < n) i += 1;\n  return i;\n}\n`;
  const testSource = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { clamp } from '../src/calc.mjs';
test('clamp caps big values', () => {
  if (process.env.CUPEL_MUTANT) writeFileSync(new URL('../src/calc.mjs', import.meta.url),
    ${JSON.stringify(original.replace('x > 10', 'x < 10'))});
  assert.equal(clamp(50), 10);
});
`;
  const p = makeProject({ 'tests/calc.test.mjs': testSource });
  t.after(p.cleanup);
  await assert.rejects(mutateNode({ root: p.root, input: p.input,
    scope: { changed: { 'src/calc.mjs': '2' } }, jobs: 1 }), error =>
    error instanceof SourceChangedError && error.exit === 3);
});
