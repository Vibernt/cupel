// Mutation for Node: the kill rule (K5), flake confirmation (K7) and the known-good check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutateNode, confirmSurvivors, generateMutants, EnvironmentError } from '../src/mutate/index.mjs';
import { makeProject, ID } from './mutate-helpers.mjs';

test('a crash before any test reports is an error, never a kill', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const r = await mutateNode({ root: p.root, input: p.input, scope: { changed: { 'src/guard.mjs': '2' } } });
  const ops = Object.fromEntries(r.mutants.map((m) => [m.operator, m]));
  // `if (!ok)` -> `if (ok)` and `if (!(!ok))` call process.exit(1) with no test reported: errors, not kills.
  assert.equal(ops['remove-not'].status, 'error');
  assert.equal(ops['negate-cond'].status, 'error');
  assert.equal(ops['remove-not'].killedBy, undefined);
  // Removing the exit call changes nothing the test sees.
  assert.equal(ops['remove-call'].status, 'survived');
});

test('a failure no input test accounts for is not a kill', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  // The input does not know the test that catches `x > 10` -> `x <= 10`, so its failure cannot be credited.
  const input = { ...p.input, tests: p.input.tests.filter((x) => x.id !== ID.caps), coverage: { ...p.input.coverage, byTest: { ...p.input.coverage.byTest } } };
  delete input.coverage.byTest[ID.caps];
  const r = await mutateNode({ root: p.root, input, scope: { changed: { 'src/calc.mjs': '3' } } });
  assert.deepEqual(r.mutants.map((m) => m.status), ['survived']);
  const r2 = await mutateNode({ root: p.root, input, scope: { changed: { 'src/calc.mjs': '2' } } });
  const flip = r2.mutants.find((m) => m.operator === 'cmp-flip');
  assert.equal(flip.status, 'error');
  assert.equal(flip.killedBy, undefined);
});

test('confirmSurvivors keeps a survivor only when it survives twice more', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const text = readFileSync(`${p.root}/src/calc.mjs`, 'utf8');
  const gen = generateMutants('src/calc.mjs', text).filter((m) => m.line === 2 || m.line === 3);
  const id = (line, op) => gen.find((m) => m.line === line && m.operator === op).id;
  const entry = (line, op, status, killedBy) => ({ id: id(line, op), source: 'src/calc.mjs', line, operator: op, status, ...(killedBy ? { killedBy } : {}) });
  // A mutation result where one survivor was a flaky miss: `x > 10` -> `x <= 10` is in fact killed.
  const mutation = {
    mutants: [
      entry(2, 'cmp-flip', 'survived'),
      entry(2, 'boundary', 'survived'),
      entry(2, 'return-value', 'killed', [ID.caps]),
      entry(3, 'return-value', 'survived'),
    ],
    targeted: [ID.small],
    seed: 20261021,
    sampled: false,
  };
  const snapshot = JSON.stringify(mutation);
  const ids = [id(2, 'cmp-flip'), id(2, 'boundary'), id(3, 'return-value'), id(2, 'return-value')];
  const out = await confirmSurvivors({ root: p.root, input: p.input, mutation, ids });
  assert.equal(JSON.stringify(mutation), snapshot, 'the given mutation is not changed');
  assert.deepEqual(out.mutants[0], { ...mutation.mutants[0], status: 'killed', killedBy: [ID.caps] });
  assert.deepEqual(out.mutants.slice(1), mutation.mutants.slice(1));
  assert.deepEqual(out.targeted, [ID.small]);
  await assert.rejects(confirmSurvivors({ root: p.root, input: p.input, mutation, ids: ['src/calc.mjs:99:1:arith:00000000'] }), TypeError);
});

test('a test file that does not run cleanly unmutated is an environment error', async (t) => {
  const p = makeProject({ 'tests/calc.test.mjs': "import './missing.mjs';\nimport { test } from 'node:test';\ntest('never', () => {});\n" });
  t.after(p.cleanup);
  await assert.rejects(
    mutateNode({ root: p.root, input: p.input, scope: { changed: { 'src/calc.mjs': '2' } } }),
    (error) => error instanceof EnvironmentError && error.exit === 3 && /tests\/calc\.test\.mjs/.test(error.message),
  );
});
