// P1-P3 (plan) and C1-C4 (check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, input, t, mutant } from './engine-helpers.mjs';

const suite = () => input({
  sources: { 'src/a.mjs': { coverable: '1-100' }, 'src/b.mjs': { coverable: '1-100' } },
  tests: [
    t('crit', { tags: ['critical'], durationsMs: [30, 30] }),
    t('std1', { durationsMs: [20, 20] }),
    t('std2', { durationsMs: [5, 5] }),
    t('min1', { tags: ['minor'], durationsMs: [1, 1] }),
    t('min2', { tags: ['minor'], durationsMs: [2, 2], file: 'tests/m.test.mjs' }),
    t('std3', { durationsMs: [5, 5], file: 'tests/s.test.mjs' }),
  ],
  cov: {
    crit: { 'src/a.mjs': '1' }, std1: { 'src/a.mjs': '10-20' }, std2: { 'src/b.mjs': '5' },
    min1: { 'src/b.mjs': '50' }, min2: { 'src/a.mjs': '60' }, std3: { 'src/b.mjs': '70' },
  },
  setup: { 'tests/s.test.mjs': { 'src/a.mjs': '90' } },
});

const plan = (args) => go('plan', { input: suite() }, {}, args);
const order = (r) => r.report.plan.order.map((e) => `${e.bucket}:${e.id}`);

test('P1 full mode: critical, standard, minor; duration then id', () => {
  const r = plan({});
  assert.equal(r.exit, 0);
  assert.equal(r.report.plan.mode, 'full');
  assert.deepEqual(order(r), ['critical:crit', 'standard:std2', 'standard:std3', 'standard:std1', 'minor:min1', 'minor:min2']);
  assert.deepEqual(r.report.plan.skipped, []);
  assert.deepEqual(r.report.plan.order[0], { id: 'crit', bucket: 'critical', durationMs: 30 });
});

test('P2 changed mode: critical, affected (lines, setup or test file), rest; unaffected minor skipped', () => {
  const r = plan({ changed: { 'src/a.mjs': '15,60', 'src/b.mjs': '', 'tests/s.test.mjs': '1' } });
  assert.equal(r.report.plan.mode, 'changed');
  // std1: line 15. min2: line 60. std2, min1, std3: b.mjs changed in full. std3: also its test file.
  assert.deepEqual(order(r), ['critical:crit', 'affected:min1', 'affected:min2', 'affected:std2', 'affected:std3', 'affected:std1']);
  assert.deepEqual(r.report.plan.skipped, []);
});

test('P2 negative: nothing affected leaves standard in rest and minor in skipped', () => {
  const r = plan({ changed: { 'src/a.mjs': '99' } });
  assert.deepEqual(order(r), ['critical:crit', 'rest:std2', 'rest:std3', 'rest:std1']);
  assert.deepEqual(r.report.plan.skipped, ['min1', 'min2']);
  const setup = plan({ changed: { 'src/a.mjs': '90' } }); // tests/s.test.mjs setup line
  assert.ok(order(setup).includes('affected:std3'));
});

test('P3 expectedMs sums the ordered units only', () => {
  assert.equal(plan({}).report.plan.expectedMs, 30 + 20 + 5 + 1 + 2 + 5);
  assert.equal(plan({ changed: { 'src/a.mjs': '99' } }).report.plan.expectedMs, 30 + 5 + 5 + 20);
});

const checkDoc = () => input({
  tests: [
    t('val'), t('dup'), t('big'), t('crit', { tags: ['critical'] }), t('killer'),
    t('f', { status: 'failed' }), t('s', { status: 'skipped' }), t('r#1', { unit: 'r' }), t('lonely'),
  ],
  cov: {
    val: { 'src/a.mjs': '1-5' }, dup: { 'src/a.mjs': '10-12' }, big: { 'src/a.mjs': '10-20' },
    crit: { 'src/a.mjs': '10' }, killer: { 'src/a.mjs': '30' }, 'r#1': { 'src/a.mjs': '30' },
  },
  mutants: [mutant('m1', 30, ['killer'])],
  brittleness: [{ test: 'dup', kind: 'css-class' }],
});

const check = (tests, inputs = { input: checkDoc() }) => go('check', inputs, {}, { tests });

test('C1 adds-value: critical, unique lines or unique kills; exit 0 when all add value', () => {
  const r = check(['val', 'crit', 'killer']);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.report.check.verdicts, [
    { id: 'crit', verdict: 'adds-value', brittle: [] },
    { id: 'killer', verdict: 'adds-value', brittle: [] },
    { id: 'val', verdict: 'adds-value', brittle: [] },
  ]);
});

test('C2 no-unique-evidence: extend names the largest overlap, or null; exit 0', () => {
  const r = check(['dup', 'lonely', 'r#1']);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.report.check.verdicts, [
    { id: 'dup', verdict: 'no-unique-evidence', extend: 'big', brittle: ['css-class'] },
    { id: 'lonely', verdict: 'no-unique-evidence', extend: null, brittle: [] },
    { id: 'r', verdict: 'no-unique-evidence', extend: 'killer', brittle: [] }, // a test id names its unit
  ]);
});

test('C4 fails and not-run take precedence', () => {
  const r = check(['f', 's']);
  assert.equal(r.exit, 1);
  assert.deepEqual(r.report.check.verdicts.map((v) => v.verdict), ['fails', 'not-run']);
});

test('C3 weakens: lost lines and lost mutants against a base, before C1', () => {
  const base = checkDoc();
  const head = checkDoc();
  head.coverage.byTest.val = { 'src/a.mjs': '1-3' };
  head.mutation.mutants[0].killedBy = ['r#1'];
  const r = check(['val', 'killer', 'big'], { base, head });
  assert.equal(r.exit, 1);
  assert.deepEqual(r.report.check.verdicts, [
    { id: 'big', verdict: 'adds-value', brittle: [] },
    { id: 'killer', verdict: 'weakens', brittle: [], lost: { lines: {}, mutants: ['m1'] } },
    { id: 'val', verdict: 'weakens', brittle: [], lost: { lines: { 'src/a.mjs': '4-5' }, mutants: [] } },
  ]);
});

test('C3 negatives: no base, unit new at head, or a mutant gone at head', () => {
  const head = checkDoc();
  const base = checkDoc();
  base.tests = base.tests.filter((x) => x.id !== 'val');
  delete base.coverage.byTest.val;
  head.coverage.byTest.val = { 'src/a.mjs': '1-3' };
  assert.equal(check(['val'], { base, head }).report.check.verdicts[0].verdict, 'adds-value');
  const gone = checkDoc();
  gone.mutation.mutants = [];
  // m1 is not present at head, so it is not compared (C3); killer has no unique evidence left.
  assert.equal(check(['killer'], { base: checkDoc(), head: gone }).report.check.verdicts[0].verdict, 'no-unique-evidence');
  // With no mutation data at head at all, the mutants detected at base count as lost (ENGINE-NOTES).
  const noData = checkDoc();
  delete noData.mutation;
  noData.brittleness = checkDoc().brittleness;
  assert.deepEqual(check(['killer'], { base: checkDoc(), head: noData }).report.check.verdicts[0].lost, { lines: {}, mutants: ['m1'] });
});
