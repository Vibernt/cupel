// Mutation for Node: stable ids, deterministic sampling, and the caps (maxMutants, maxSeconds) with `sampled`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutateNode, generateMutants, sample } from '../src/mutate/index.mjs';
import { makeProject, ID } from './mutate-helpers.mjs';

test('ids are stable for the same source text and site, and sampling is seeded', () => {
  const p = makeProject();
  try {
    const text = readFileSync(`${p.root}/src/calc.mjs`, 'utf8');
    const a = generateMutants('src/calc.mjs', text).map((m) => m.id);
    assert.deepEqual(generateMutants('src/calc.mjs', text).map((m) => m.id), a);
    assert.equal(new Set(a).size, a.length);
    // Code added above shifts the lines, but each site keeps its operator and replacement hash.
    const shifted = generateMutants('src/calc.mjs', `// header\n${text}`).map((m) => m.id);
    assert.deepEqual(shifted.map((id) => id.replace(/:\d+:\d+:/, ':')), a.map((id) => id.replace(/:\d+:\d+:/, ':')));
    const list = Array.from({ length: 50 }, (_, k) => k);
    assert.deepEqual(sample(list, 7, 1), sample(list, 7, 1));
    assert.notDeepEqual(sample(list, 7, 1), sample(list, 7, 2));
    assert.deepEqual(sample(list, 7, 1), [...sample(list, 7, 1)].sort((x, y) => x - y));
  } finally {
    p.cleanup();
  }
});

test('maxMutants caps the run with a seeded sample and sets sampled; within the cap, sampled is false', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const scope = { changed: { 'src/calc.mjs': '2-3' } };
  const capped = { mutation: { maxMutants: 2, seed: 7 } };
  const [a, b, all] = await Promise.all([
    mutateNode({ root: p.root, config: capped, input: p.input, scope }),
    mutateNode({ root: p.root, config: capped, input: p.input, scope }),
    mutateNode({ root: p.root, config: { mutation: { maxMutants: 5 } }, input: p.input, scope }),
  ]);
  assert.equal(a.mutants.length, 2);
  assert.equal(a.sampled, true);
  assert.equal(a.seed, 7);
  assert.deepEqual(a, b);
  assert.equal(all.mutants.length, 5);
  assert.equal(all.sampled, false);
  const ids = all.mutants.map((m) => m.id);
  for (const m of a.mutants) assert.ok(ids.includes(m.id));
  // Order follows the source, whatever the sample.
  assert.deepEqual(a.mutants.map((m) => m.id), ids.filter((id) => a.mutants.some((m) => m.id === id)));
});

test('a targeted unit is listed only when every mutant on its own lines ran', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  // The cap keeps 2 of the 5 mutants on lines 2-3, so the unit owning those lines is not complete.
  const r = await mutateNode({ root: p.root, config: { mutation: { maxMutants: 2 } }, input: p.input, scope: { targeted: [ID.small] } });
  assert.equal(r.mutants.length, 2);
  assert.equal(r.sampled, true);
  assert.deepEqual(r.targeted, []);
});

test('maxSeconds stops the run, drops what did not finish and sets sampled', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const r = await mutateNode({ root: p.root, config: { mutation: { maxSeconds: 1 } }, input: p.input, scope: { changed: { 'src/calc.mjs': '' } }, jobs: 1 });
  assert.equal(r.sampled, true);
  // The infinite loop alone outlasts the budget (its first run takes at least the 1 s timeout floor), so it is
  // dropped rather than reported half-run.
  assert.ok(r.mutants.length < 10, `${r.mutants.length} mutants ran in 1 s with one process`);
  assert.equal(r.mutants.some((m) => m.line === 8 && m.operator === 'arith'), false);
  for (const m of r.mutants) assert.notEqual(m.status, 'error');
});
