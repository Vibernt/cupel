// A1-A12: advice, hints, consolidation groups (A9) and the retire pass (A10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { input, t, report, unit, mutant } from './engine-helpers.mjs';

const advice = (rep, id) => {
  const u = unit(rep, id);
  const out = { advice: u.advice, reasons: u.reasons, hints: u.hints };
  if (u.group) out.group = u.group;
  if (u.duplicateOf) out.duplicateOf = u.duplicateOf;
  return out;
};
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => i + from);

test('A1 failed unit: none, reason failed, even with unique lines', () => {
  const r = report(input({ tests: [t('f', { status: 'failed' })], cov: { f: { 'src/a.mjs': '1-9' } } }));
  assert.deepEqual(advice(r, 'f'), { advice: 'none', reasons: ['failed'], hints: [] });
});

test('A2 skipped unit: none, reason not-run', () => {
  const r = report(input({ tests: [t('s', { status: 'skipped' })] }));
  assert.deepEqual(advice(r, 's'), { advice: 'none', reasons: ['not-run'], hints: [] });
});

test('A3 pinned: rewrite with sorted brittle reasons; A4 all deliberate: move-to-check', () => {
  const r = report(input({
    tests: [t('p'), t('d'), t('mixed')],
    cov: { p: { 'src/a.mjs': '1' }, d: { 'src/a.mjs': '2' }, mixed: { 'src/a.mjs': '3' } },
    brittleness: [
      { test: 'p', kind: 'source-text' }, { test: 'p', kind: 'css-class' },
      { test: 'd', kind: 'file-snapshot', deliberate: true },
      { test: 'mixed', kind: 'file-snapshot', deliberate: true }, { test: 'mixed', kind: 'doc-wording', deliberate: false },
    ],
  }));
  assert.deepEqual(advice(r, 'p'), { advice: 'rewrite', reasons: ['brittle:css-class', 'brittle:source-text'], hints: [] });
  assert.deepEqual(advice(r, 'd'), { advice: 'move-to-check', reasons: ['deliberate-pin'], hints: [] });
  assert.deepEqual(advice(r, 'mixed'), { advice: 'rewrite', reasons: ['brittle:doc-wording', 'brittle:file-snapshot'], hints: [] });
});

test('A5/A9 consolidation groups: linked by shape and line Jaccard, numbered by smallest id', () => {
  const shape = range(10);
  const r = report(input({
    tests: [
      t('b1'), t('b2'), t('b3'),
      t('a1', { file: 'tests/z.test.mjs' }), t('a2', { file: 'tests/z.test.mjs' }),
      t('lone'), t('far'),
    ],
    cov: {
      b1: { 'src/a.mjs': '1-10' }, b2: { 'src/a.mjs': '5-14' }, b3: { 'src/a.mjs': '8-16' },
      a1: { 'src/a.mjs': '30-40' }, a2: { 'src/a.mjs': '30-40' },
      lone: { 'src/a.mjs': '1-10' }, far: { 'src/a.mjs': '90-99' },
    },
    shapes: { b1: shape, b2: shape, b3: range(10, 2), a1: shape, a2: shape, lone: range(10, 50), far: shape },
  }));
  assert.deepEqual(r.report.groups, [
    { id: 'g1', kind: 'same-shape', file: 'tests/z.test.mjs', units: ['a1', 'a2'] },
    { id: 'g2', kind: 'same-shape', file: 'tests/a.test.mjs', units: ['b1', 'b2', 'b3'] }, // b1-b2-b3 chain
  ]);
  assert.deepEqual(advice(r, 'b3'), { advice: 'consolidate', reasons: ['same-shape'], hints: [], group: 'g2' });
  assert.equal(unit(r, 'lone').advice, 'keep'); // shape too different
  assert.equal(unit(r, 'far').advice, 'keep'); // lines too different
});

test('A9 negative: critical and non-critical never link; brittle, failed, or consolidate:false never join', () => {
  const shape = range(10);
  const base = {
    tests: [t('x', { tags: ['critical'] }), t('y'), t('z'), t('w')],
    cov: { x: { 'src/a.mjs': '1-10' }, y: { 'src/a.mjs': '1-10' }, z: { 'src/a.mjs': '1-10' }, w: { 'src/a.mjs': '1-10' } },
    shapes: { x: shape, y: shape, z: shape, w: shape },
  };
  assert.deepEqual(report(input(base)).report.groups.map((g) => g.units), [['w', 'y', 'z']]);
  const brittle = input({ ...base, brittleness: [{ test: 'y', kind: 'css-class', deliberate: true }] });
  brittle.tests[3].status = 'failed';
  assert.deepEqual(report(brittle).report.groups, []);
  assert.deepEqual(report(input(base), { advice: { consolidate: false } }).report.groups, []);
});

test('A6 slow and low value: rewrite; needs runs, duration, few unique lines and not critical', () => {
  const r = report(input({
    tests: [
      t('slow', { durationsMs: [3000, 2500] }),
      t('once', { durationsMs: [9000] }),
      t('slowcrit', { durationsMs: [3000, 3000], tags: ['critical'] }),
      t('valuable', { durationsMs: [3000, 3000] }),
    ],
    cov: { slow: { 'src/a.mjs': '1-4' }, once: { 'src/a.mjs': '5' }, slowcrit: { 'src/a.mjs': '6' }, valuable: { 'src/a.mjs': '10-20' } },
  }));
  assert.deepEqual(advice(r, 'slow'), { advice: 'rewrite', reasons: ['slow-low-value'], hints: [] });
  assert.deepEqual(advice(r, 'once'), { advice: 'keep', reasons: ['unique-lines'], hints: [] });
  assert.deepEqual(advice(r, 'slowcrit'), { advice: 'keep', reasons: ['critical', 'unique-lines'], hints: [] });
  assert.deepEqual(advice(r, 'valuable'), { advice: 'keep', reasons: ['unique-lines'], hints: [] });
});

test('A7 keep with evidence: reasons in the order critical, unique-lines, unique-kills', () => {
  const r = report(input({
    tests: [t('all', { tags: ['critical'] }), t('k'), t('other')],
    cov: { all: { 'src/a.mjs': '1' }, k: { 'src/a.mjs': '2' }, other: { 'src/a.mjs': '2' } },
    mutants: [mutant('m1', 1, ['all']), mutant('m2', 2, ['k'])],
  }));
  assert.deepEqual(advice(r, 'all').reasons, ['critical', 'unique-lines', 'unique-kills']);
  assert.deepEqual(advice(r, 'k').reasons, ['unique-kills']);
});

test('A8 no coverage: none with hint no-coverage-evidence', () => {
  const r = report(input({ tests: [t('empty')] }));
  assert.deepEqual(advice(r, 'empty'), { advice: 'none', reasons: [], hints: ['no-coverage-evidence'] });
});

test('A11 otherwise: keep with hint no-unique-coverage-unverified', () => {
  const r = report(input({ tests: [t('a'), t('b')], cov: { a: { 'src/a.mjs': '1-3' }, b: { 'src/a.mjs': '1-3' } } }));
  assert.deepEqual(advice(r, 'a'), { advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] });
});

// A unit `cand` whose lines are all covered by `big`, which also kills every mutant.
const retireCase = (over = {}) => input({
  tests: [t('big', { durationsMs: [1, 1] }), t('cand', { durationsMs: [50, 50] })],
  cov: { big: { 'src/a.mjs': '1-10' }, cand: { 'src/a.mjs': '2-3' } },
  rechecked: ['cand'],
  mutants: [mutant('m1', 2, ['big', 'cand'])],
  targeted: ['cand'],
  ...over,
});

test('A10 mutation path: retire with no-unique-lines, no-unique-kills', () => {
  const r = report(retireCase());
  assert.deepEqual(advice(r, 'cand'), { advice: 'retire', reasons: ['no-unique-lines', 'no-unique-kills'], hints: [] });
  assert.equal(r.report.suite.advice.retire, 1);
});

test('A10 negatives: not rechecked, not targeted, missing mutation data, unique kills', () => {
  const keep = { advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] };
  assert.deepEqual(advice(report(retireCase({ rechecked: [] })), 'cand'), keep);
  assert.deepEqual(advice(report(retireCase({ targeted: [] })), 'cand'), keep);
  assert.deepEqual(advice(report(retireCase({ mutants: undefined, targeted: undefined })), 'cand'), keep);
  const killer = report(retireCase({ mutants: [mutant('m1', 2, ['cand'])] }));
  assert.deepEqual(advice(killer, 'cand'), { advice: 'keep', reasons: ['unique-kills'], hints: [] });
});

test('A10 never retires protected, e2e or interpreter-spawning units', () => {
  const crit = retireCase({ sources: { 'src/a.mjs': { coverable: '1-100' }, 'src/token.mjs': { coverable: '1-5' } } });
  crit.coverage.byTest.cand['src/token.mjs'] = '1';
  crit.coverage.byTest.big['src/token.mjs'] = '1';
  assert.equal(unit(report(crit), 'cand').protected, true);
  assert.equal(unit(report(crit), 'cand').advice, 'keep');

  const e2e = retireCase();
  e2e.tests[1].kind = 'e2e';
  assert.deepEqual(advice(report(e2e), 'cand'), { advice: 'keep', reasons: [], hints: ['low-evidence', 'no-unique-coverage-unverified'] });
  const sp = retireCase();
  sp.tests[1].spawnsInterpreter = true;
  assert.deepEqual(advice(report(sp), 'cand').hints, ['no-unique-coverage-unverified', 'spawns-interpreter']);
});

test('A10 duplicate path: retire with duplicate-of and the smallest qualifying duplicateOf', () => {
  const shape = range(20);
  const doc = input({
    tests: [t('cand', { durationsMs: [9, 9] }), t('v2'), t('v1')],
    cov: { cand: { 'src/a.mjs': '1-3' }, v1: { 'src/a.mjs': '1-5' }, v2: { 'src/a.mjs': '1-9' } },
    rechecked: ['cand'],
    shapes: { cand: shape, v1: [...shape, 99], v2: shape },
  });
  const r = report(doc, { advice: { consolidate: false } });
  assert.deepEqual(advice(r, 'cand'), { advice: 'retire', reasons: ['no-unique-lines', 'duplicate-of'], hints: [], duplicateOf: 'v1' });
  // v1's shape (20/21) is below a duplicateShape of 1, so only v2 qualifies.
  const strict = report(doc, { advice: { consolidate: false, duplicateShape: 1 } });
  assert.equal(unit(strict, 'cand').duplicateOf, 'v2');
  // A partner whose own lines do not include the candidate's never qualifies.
  const notSuperset = JSON.parse(JSON.stringify(doc));
  notSuperset.coverage.byTest = { cand: { 'src/a.mjs': '1-3' }, v1: { 'src/a.mjs': '2-5' }, v2: { 'src/a.mjs': '1-2' } };
  assert.deepEqual(notSuperset.coverage.rechecked, ['cand']);
  assert.equal(unit(report(notSuperset, { advice: { consolidate: false } }), 'cand').advice, 'keep');
});

test('A10 joint safety: of two identical duplicates only the slower one retires', () => {
  const shape = range(20);
  const doc = input({
    tests: [t('fast', { durationsMs: [1, 1] }), t('slow', { durationsMs: [80, 80] })],
    cov: { fast: { 'src/a.mjs': '1-3' }, slow: { 'src/a.mjs': '1-3' } },
    rechecked: ['fast', 'slow'],
    shapes: { fast: shape, slow: shape },
  });
  const r = report(doc, { advice: { consolidate: false } });
  assert.deepEqual(advice(r, 'slow'), { advice: 'retire', reasons: ['no-unique-lines', 'duplicate-of'], hints: [], duplicateOf: 'fast' });
  assert.deepEqual(advice(r, 'fast'), { advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified', 'retire-conflict'] });
});

test('A10 joint safety: the last killer of a mutant is not retired', () => {
  const doc = input({
    tests: [t('x'), t('u', { durationsMs: [5, 5] }), t('w', { durationsMs: [7, 7] })],
    cov: { x: { 'src/a.mjs': '1-10' }, u: { 'src/a.mjs': '1' }, w: { 'src/a.mjs': '2' } },
    rechecked: ['u', 'w'],
    mutants: [mutant('m1', 1, ['u', 'w'])],
    targeted: ['u', 'w'],
  });
  const r = report(doc);
  assert.equal(unit(r, 'w').advice, 'retire'); // slower, considered first
  assert.deepEqual(advice(r, 'u'), { advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified', 'retire-conflict'] });
});

test('A10 joint safety: a failed unit\'s coverage never stands in for a retired one', () => {
  const doc = retireCase();
  doc.tests[0].status = 'failed';
  const r = report(doc);
  assert.deepEqual(advice(r, 'cand'), { advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified', 'retire-conflict'] });
});

test('A12 file granularity: null unique signals, keep with file-granularity, critical keeps reason', () => {
  const doc = input({
    granularity: 'file',
    tests: [t('a'), t('c', { tags: ['critical'] }), t('z', { file: 'tests/z.test.mjs' })],
    byFile: { 'tests/a.test.mjs': { 'src/a.mjs': '1-5' }, 'tests/z.test.mjs': { 'src/a.mjs': '1-5' } },
    rechecked: ['a'],
    mutants: [mutant('m1', 1, ['a'])],
    targeted: ['a'],
  });
  const r = report(doc);
  assert.deepEqual(advice(r, 'a'), { advice: 'keep', reasons: [], hints: ['file-granularity'] });
  assert.deepEqual(advice(r, 'c'), { advice: 'keep', reasons: ['critical'], hints: [] });
  assert.equal(unit(r, 'a').signals.uniqueLines, null);
  assert.equal(unit(r, 'a').signals.uniqueKills, null);
  assert.equal(unit(r, 'a').signals.kills, 1);
  assert.deepEqual(r.report.files, [
    { file: 'tests/a.test.mjs', uniqueLines: 0, hints: ['file-no-unique-coverage'] },
    { file: 'tests/z.test.mjs', uniqueLines: 0, hints: ['file-no-unique-coverage'] },
  ]);
  const one = input({ granularity: 'file', tests: [t('a')], byFile: { 'tests/a.test.mjs': { 'src/a.mjs': '1-5' } } });
  assert.deepEqual(report(one).report.files, [{ file: 'tests/a.test.mjs', uniqueLines: 5, hints: [] }]);
  assert.equal(report(retireCase()).report.files, undefined); // only at file granularity
});
