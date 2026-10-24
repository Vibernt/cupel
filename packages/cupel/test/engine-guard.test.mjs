// G1-G9 (guard) and E1 exit codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, input, t, mutant, clone } from './engine-helpers.mjs';

const doc = () => input({
  sources: {
    'src/a.mjs': { coverable: '1-10', hash: 'ha' },
    'src/auth.mjs': { coverable: '1-10', hash: 'hx' },
    'src/nohash.mjs': { coverable: '1-10' },
  },
  tests: [t('x'), t('crit', { tags: ['critical'] }), t('y')],
  cov: {
    x: { 'src/a.mjs': '1-5', 'src/nohash.mjs': '1-5' },
    crit: { 'src/auth.mjs': '1-8' },
    y: { 'src/a.mjs': '6' },
  },
  mutants: [mutant('m1', 2, ['crit'], 'killed', 'src/auth.mjs'), mutant('m2', 1, ['x'])],
});

const guard = (base, head, config = {}, args = {}) => go('guard', { base, head }, config, args);
const check = (r, id) => r.report.guard.checks.find((c) => c.id === id);
const IDS = ['head-passes', 'coverage-lines', 'coverage-ratio', 'critical-coverage', 'critical-mutation', 'critical-removed', 'critical-downgraded'];

test('guard passes on identical inputs and lists the seven checks once, in order', () => {
  const r = guard(doc(), doc());
  assert.equal(r.exit, 0);
  assert.equal(r.report.guard.pass, true);
  assert.deepEqual(r.report.guard.checks.map((c) => c.id), IDS);
  assert.deepEqual(r.report.guard.removed, []);
  assert.deepEqual(r.report.guard.renamed, []);
  assert.deepEqual(check(r, 'coverage-ratio'), {
    id: 'coverage-ratio', pass: true,
    base: { covered: 19, coverable: 30, pct: 63.33 }, head: { covered: 19, coverable: 30, pct: 63.33 },
  });
});

test('G1 runtime mismatch exits 3 with only the minimal report', () => {
  const head = doc();
  head.runtime.version = '22.0.1';
  const r = guard(doc(), head);
  assert.equal(r.exit, 3);
  assert.deepEqual(r.report.diagnostics.map((d) => d.code), ['runtime-mismatch']);
  assert.deepEqual(Object.keys(r.report), ['spec', 'kind', 'command', 'diagnostics']);
});

test('G3 head-passes fails when a unit fails at head', () => {
  const head = doc();
  head.tests[2].status = 'failed';
  const r = guard(doc(), head);
  assert.equal(r.exit, 1);
  assert.equal(check(r, 'head-passes').pass, false);
});

test('G4 coverage-lines: lost lines on sources with equal, present hashes only', () => {
  const head = doc();
  head.coverage.byTest.x = { 'src/a.mjs': '1-3' }; // loses a.mjs 4-5 and nohash 1-5
  const r = guard(doc(), head);
  assert.deepEqual(check(r, 'coverage-lines'), { id: 'coverage-lines', pass: false, lost: { lines: { 'src/a.mjs': '4-5' } } });
  assert.equal(check(r, 'coverage-ratio').pass, false);
  // A changed hash: the source is not compared line by line.
  head.sources['src/a.mjs'].hash = 'new';
  assert.equal(check(guard(doc(), head), 'coverage-lines').pass, true);
});

test('G4 setup lines count as covered', () => {
  const base = doc();
  const head = doc();
  head.coverage.byTest.y = {};
  head.coverage.setup = { 'tests/a.test.mjs': { 'src/a.mjs': '6' } };
  assert.equal(check(guard(base, head), 'coverage-lines').pass, true);
});

test('G4 coverage-ratio is compared exactly: more coverable lines can lower the ratio', () => {
  const head = doc();
  head.sources['src/nohash.mjs'].coverable = '1-11';
  const r = guard(doc(), head);
  assert.equal(check(r, 'coverage-lines').pass, true);
  // 19/30 > 19/31, though both show as a similar pct.
  assert.equal(check(r, 'coverage-ratio').pass, false);
});

test('G4 and G5 omit unstable lines from covered and coverable on both sides', () => {
  const base = doc(), head = doc();
  head.coverage.byTest.crit = { 'src/auth.mjs': '1-6' };
  base.coverage.unstable = { 'src/auth.mjs': '7' };
  head.coverage.unstable = { 'src/auth.mjs': '8' };
  const result = guard(base, head);
  assert.deepEqual(check(result, 'coverage-lines').lost.lines, {});
  assert.equal(check(result, 'coverage-ratio').pass, true);
  assert.equal(check(result, 'critical-coverage').pass, true);
  assert.deepEqual(check(result, 'coverage-ratio').base, { covered: 17, coverable: 28, pct: 60.71 });
});

test('G7 and G9 match same-file renames greedily and retain an unapproved critical downgrade', () => {
  const base = input({ tests: [t('old-a', { tags: ['critical'] }), t('old-b')],
    cov: { 'old-a': { 'src/a.mjs': '1' }, 'old-b': { 'src/a.mjs': '2' } },
    shapes: { 'old-a': [1, 2, 3], 'old-b': [1, 2, 4] } });
  const head = input({ tests: [t('new-a', { tags: ['critical'] }), t('new-b')],
    cov: { 'new-a': { 'src/a.mjs': '1' }, 'new-b': { 'src/a.mjs': '2' } },
    shapes: { 'new-a': [1, 2, 3], 'new-b': [1, 2, 4] } });
  const result = guard(base, head, { advice: { duplicateShape: 0.5 } });
  assert.deepEqual(result.report.guard.renamed, [{ from: 'old-a', to: 'new-a' }, { from: 'old-b', to: 'new-b' }]);
  assert.deepEqual(result.report.guard.removed, []);
  assert.deepEqual(check(result, 'critical-removed').units, []);
  head.tests[0].tags = [];
  assert.deepEqual(check(guard(base, head, { advice: { duplicateShape: 0.5 } }), 'critical-removed').units, ['old-a']);
});

test('G5 critical-coverage: ratchet per critical source, and an optional floor', () => {
  const head = doc();
  head.coverage.byTest.crit = { 'src/auth.mjs': '1-7' };
  const r = guard(doc(), head);
  assert.deepEqual(check(r, 'critical-coverage'), { id: 'critical-coverage', pass: false, sources: ['src/auth.mjs'] });
  assert.equal(check(guard(doc(), doc(), { guard: { criticalCoverage: 80 } }), 'critical-coverage').pass, true);
  const floor = guard(doc(), doc(), { guard: { criticalCoverage: 80.5 } });
  assert.deepEqual(check(floor, 'critical-coverage'), { id: 'critical-coverage', pass: false, sources: ['src/auth.mjs'] });
});

test('G6 critical-mutation: a critical mutant detected at base must stay detected', () => {
  const head = doc();
  head.mutation.mutants[0].status = 'survived';
  head.mutation.mutants[1].status = 'survived'; // not critical: ignored here
  const r = guard(doc(), head);
  const c = check(r, 'critical-mutation');
  assert.equal(c.pass, false);
  assert.deepEqual(c.lost, { mutants: ['m1'] });
  // A mutant absent at head (by id) is not compared.
  head.mutation.mutants[0].id = 'm1-renamed';
  assert.equal(check(guard(doc(), head), 'critical-mutation').pass, true);
});

test('G6 missing mutation data at head fails with missing: true', () => {
  const head = doc();
  delete head.mutation;
  assert.deepEqual(check(guard(doc(), head), 'critical-mutation'), { id: 'critical-mutation', pass: false, missing: true });
  // No critical mutant at base: nothing to lose.
  const base = doc();
  base.mutation.mutants = [mutant('m2', 1, ['x'])];
  assert.equal(check(guard(base, head), 'critical-mutation').pass, true);
});

test('G7 critical-removed needs a remove approval; G9 lists every removed unit from base', () => {
  const head = doc();
  head.tests = head.tests.filter((x) => x.id === 'x');
  head.coverage.byTest = { x: clone(doc().coverage.byTest.x) };
  head.mutation.mutants = [mutant('m2', 1, ['x'])];
  const r = guard(doc(), head);
  assert.deepEqual(check(r, 'critical-removed'), { id: 'critical-removed', pass: false, units: ['crit'] });
  assert.deepEqual(r.report.guard.removed, [
    { id: 'crit', tier: 'critical', uniqueLines: 8, uniqueKills: 1 },
    { id: 'y', tier: 'standard', uniqueLines: 1, uniqueKills: 0 },
  ]);
  const ok = guard(doc(), head, {}, { approvals: [{ action: 'remove', id: 'crit', by: 'owner' }] });
  assert.equal(check(ok, 'critical-removed').pass, true);
  const wrong = guard(doc(), head, {}, { approvals: [{ action: 'downgrade', id: 'crit', by: 'owner' }] });
  assert.equal(check(wrong, 'critical-removed').pass, false);
});

test('G8 critical-downgraded needs a downgrade approval', () => {
  const head = doc();
  head.tests[1].tags = ['standard'];
  const r = guard(doc(), head);
  assert.deepEqual(check(r, 'critical-downgraded'), { id: 'critical-downgraded', pass: false, units: ['crit'] });
  assert.equal(r.exit, 1);
  const ok = guard(doc(), head, {}, { approvals: [{ action: 'downgrade', id: 'crit', by: 'owner' }] });
  assert.equal(check(ok, 'critical-downgraded').pass, true);
  assert.equal(ok.exit, 0);
});
