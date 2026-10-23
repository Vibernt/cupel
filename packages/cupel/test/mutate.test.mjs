// Mutation for Node (src/mutate/): the main run over a synthetic project. Two runs at once must give identical
// JSON, leave every project file untouched, validate against input.schema.json and feed the engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutateNode } from '../src/mutate/index.mjs';
import { run } from '../src/engine/index.mjs';
import { validate } from '../src/engine/schema.mjs';
import { makeProject, hashTree, byLineOp, ID } from './mutate-helpers.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}`, import.meta.url), 'utf8'));
const schemas = { input: load('input.schema.json'), config: load('config.schema.json'), report: load('report.schema.json') };

test('a mutation run: kills, a survivor, a timeout, determinism, no file written, schema and report', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const config = { tiers: { critical: ['src/calc.mjs'] } };
  const scope = { critical: true, changed: { 'src/guard.mjs': '' }, targeted: [ID.small] };
  const before = hashTree(p.root);
  const changes = [];
  const watch = setInterval(() => {
    const now = JSON.stringify(hashTree(p.root));
    if (now !== JSON.stringify(before)) changes.push(now);
  }, 25);
  let a, b;
  try {
    [a, b] = await Promise.all([
      mutateNode({ root: p.root, config, input: p.input, scope }),
      mutateNode({ root: p.root, config, input: p.input, scope }),
    ]);
  } finally {
    clearInterval(watch);
  }

  // Determinism: the same source, seed and tests give byte-identical JSON.
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // No project file changes during or after the runs (mutants are served in memory).
  assert.deepEqual(changes, []);
  assert.deepEqual(hashTree(p.root), before);

  const m = byLineOp(a);
  const status = (key) => Object.entries(m).find(([k]) => k.startsWith(key))?.[1];
  // Killed by exactly one test: `x > 10` -> `x <= 10` only fails the test that checks a big value.
  assert.deepEqual(status('src/calc.mjs:2:cmp-flip').killedBy, [ID.caps]);
  assert.equal(status('src/calc.mjs:2:cmp-flip').status, 'killed');
  // Survives: `x > 10` -> `x >= 10` (no test at 10) and `return x` -> `return undefined` (never asserted).
  assert.equal(status('src/calc.mjs:2:boundary').status, 'survived');
  assert.equal(status('src/calc.mjs:2:boundary').killedBy, undefined);
  assert.equal(status('src/calc.mjs:3:return-value').status, 'survived');
  // Times out: `i += 1` -> `i -= 1` loops forever; the test that was running is named.
  assert.equal(status('src/calc.mjs:8:arith').status, 'timeout');
  assert.deepEqual(status('src/calc.mjs:8:arith').killedBy, [ID.spin]);
  // Crash is not a kill: dropping the `!` exits the process before any test reports.
  assert.equal(status('src/guard.mjs:2:remove-not').status, 'error');
  assert.equal(status('src/guard.mjs:2:remove-not').killedBy, undefined);
  assert.equal(status('src/guard.mjs:3:return-value').status, 'killed');
  // A mutant that breaks module loading is a kill credited to every test of the file.
  assert.deepEqual(status('src/guard.mjs:5:cmp-flip').killedBy, [ID.guard]);

  assert.equal(a.mutants.length, 21);
  assert.equal(a.sampled, false);
  assert.equal(a.seed, 20261021);
  for (const x of a.mutants) assert.match(x.id, /^src\/(calc|guard)\.mjs:\d+:\d+:[a-z-]+:[0-9a-f]{8}$/);
  // Every mutant on the unit's own lines (2-3) ran, so the unit is targeted.
  assert.deepEqual(a.targeted, [ID.small]);

  // The output is `input.mutation`: it validates and runs through the engine.
  const input = { ...p.input, mutation: a };
  assert.deepEqual(validate(schemas.input, input), []);
  const { report, exit } = run('report', { input }, config, {}, schemas);
  assert.equal(exit, 0, JSON.stringify(report.diagnostics));
  assert.deepEqual(validate(schemas.report, report), []);
  const unit = (id) => report.units.find((u) => u.id === id);
  assert.equal(unit(ID.caps).signals.uniqueKills, 5);
  assert.equal(unit(ID.spin).signals.uniqueKills, 6);
  assert.equal(unit(ID.small).signals.kills, 0);
  // 16 detected of 19 scored; the 2 errors are not scored.
  assert.equal(report.suite.mutation.detected, 16);
  assert.equal(report.suite.mutation.undetected, 3);
});
