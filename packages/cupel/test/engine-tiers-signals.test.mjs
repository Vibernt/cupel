// T1-T8 (tiers), S1-S6 (signals) and L1 (label).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, input, t, report, unit, codes, mutant } from './engine-helpers.mjs';
import { shapeSimilarity } from '../src/engine/advice.mjs';
import { lineJaccard } from '../src/engine/model.mjs';
import { mapFrom } from '../src/engine/lines.mjs';
import { ratioAtLeast } from '../src/engine/rational.mjs';

const tier = (rep, id) => {
  const u = unit(rep, id);
  return [u.tier, u.tierReason];
};

test('T1 tags: the most protective tier tag wins', () => {
  const r = report(input({
    tests: [t('x#1', { unit: 'x', tags: ['minor'] }), t('x#2', { unit: 'x', tags: ['standard', 'critical'] }), t('y', { tags: ['minor'] })],
  }), { tiers: { critical: ['tests/**'] } });
  assert.deepEqual(tier(r, 'x'), ['critical', 'tag']);
  assert.deepEqual(tier(r, 'y'), ['minor', 'tag']); // a tag comes before the path rule
});

test('T2 unknown tags: diagnostic, tier unchanged; only label exits 1 (L1)', () => {
  const doc = input({ tests: [t('x', { tags: ['flaky'] }), t('y', { tags: ['critical', 'slow'] })] });
  const r = report(doc);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.report.diagnostics.map((d) => [d.code, d.severity, d.test]), [
    ['unknown-tag', 'error', 'x'], ['unknown-tag', 'error', 'y'],
  ]);
  assert.deepEqual(tier(r, 'x'), ['standard', 'default']);
  assert.deepEqual(tier(r, 'y'), ['critical', 'tag']);
  const l = go('label', { input: doc });
  assert.equal(l.exit, 1);
  assert.equal(go('plan', { input: doc }).exit, 0);
});

test('L1 label reports tier, tierReason and protected, and exits 0 without unknown tags', () => {
  const l = go('label', { input: input({ tests: [t('x')] }) });
  assert.equal(l.exit, 0);
  const u = unit(l, 'x');
  assert.deepEqual([u.tier, u.tierReason, u.protected], ['standard', 'default', false]);
});

test('T3 critical path rule and T6 minor path rule', () => {
  const doc = input({
    tests: [t('c', { file: 'tests/billing/pay.test.mjs' }), t('m', { file: 'tests/ui/button.test.mjs' }), t('both', { file: 'tests/ui/x.test.mjs' })],
  });
  const r = report(doc, { tiers: { critical: ['tests/billing/**', 'tests/ui/x.test.mjs'], minor: ['tests/ui/**'], pathWords: [] } });
  assert.deepEqual(tier(r, 'c'), ['critical', 'path-rule']);
  assert.deepEqual(tier(r, 'm'), ['minor', 'path-rule']);
  assert.deepEqual(tier(r, 'both'), ['critical', 'path-rule']); // T3 before T6
});

test('T4 path words on the file, title words on any row name', () => {
  const doc = input({
    tests: [
      t('p', { file: 'tests/authService.test.mjs' }),
      t('q#1', { unit: 'q', name: 'renders', file: 'tests/w.test.mjs' }),
      t('q#2', { unit: 'q', name: 'refuses a forged cookie', file: 'tests/w.test.mjs' }),
      t('r', { file: 'tests/plain.test.mjs', name: 'plain' }),
    ],
  });
  const r = report(doc);
  assert.deepEqual(tier(r, 'p'), ['critical', 'critical-word']);
  assert.deepEqual(tier(r, 'q'), ['critical', 'critical-word']);
  assert.deepEqual(tier(r, 'r'), ['standard', 'default']);
});

test('T4 word lists: replaced, or extended', () => {
  const doc = input({ tests: [t('a', { file: 'tests/auth.test.mjs' }), t('b', { file: 'tests/ledger.test.mjs' })] });
  const replaced = report(doc, { tiers: { pathWords: ['ledger'] } });
  assert.deepEqual(tier(replaced, 'a'), ['standard', 'default']);
  assert.deepEqual(tier(replaced, 'b'), ['critical', 'critical-word']);
  const extended = report(doc, { tiers: { extraPathWords: ['ledger'] } });
  assert.deepEqual(tier(extended, 'a'), ['critical', 'critical-word']);
  assert.deepEqual(tier(extended, 'b'), ['critical', 'critical-word']);
});

test('T5 unique lines in a critical source; T8 protected by own lines', () => {
  const doc = input({
    sources: { 'src/auth/session.mjs': { coverable: '1-10' }, 'src/a.mjs': { coverable: '1-10' } },
    tests: [t('u'), t('v'), t('w')],
    cov: { u: { 'src/auth/session.mjs': '1-2' }, v: { 'src/auth/session.mjs': '2', 'src/a.mjs': '1' }, w: { 'src/a.mjs': '1' } },
  });
  const r = report(doc);
  assert.deepEqual(tier(r, 'u'), ['critical', 'unique-critical-lines']);
  // v has no unique line in the critical source, but its own lines touch it: protected, not critical.
  assert.deepEqual(tier(r, 'v'), ['standard', 'default']);
  assert.equal(unit(r, 'v').protected, true);
  assert.equal(unit(r, 'w').protected, false);
});

test('T5 does not apply at file granularity (A12)', () => {
  const doc = input({
    sources: { 'src/auth.mjs': { coverable: '1-10' } },
    tests: [t('u')],
    granularity: 'file',
    byFile: { 'tests/a.test.mjs': { 'src/auth.mjs': '1' } },
  });
  const r = report(doc);
  assert.deepEqual(tier(r, 'u'), ['standard', 'default']);
  assert.equal(unit(r, 'u').protected, true);
});

test('S1 own lines exclude the file setup; S2 unique lines exclude other units and every setup', () => {
  const doc = input({
    tests: [t('a'), t('b'), t('c', { file: 'tests/c.test.mjs' })],
    cov: { a: { 'src/a.mjs': '1-10' }, b: { 'src/a.mjs': '5-6' }, c: { 'src/a.mjs': '20' } },
    setup: { 'tests/a.test.mjs': { 'src/a.mjs': '1-2' }, 'tests/c.test.mjs': { 'src/a.mjs': '3' } },
  });
  const r = report(doc);
  assert.equal(unit(r, 'a').signals.ownLines, 8); // 3-10
  assert.equal(unit(r, 'a').signals.uniqueLines, 5); // 4,7-10
  assert.equal(unit(r, 'b').signals.uniqueLines, 0);
  assert.equal(unit(r, 'c').signals.uniqueLines, 1);
});

test('S3 kills and unique kills count detected mutants only', () => {
  const doc = input({
    tests: [t('a#1', { unit: 'a' }), t('a#2', { unit: 'a' }), t('b')],
    cov: { 'a#1': { 'src/a.mjs': '1' }, b: { 'src/a.mjs': '1' } },
    mutants: [
      mutant('m1', 1, ['a#1', 'a#2']), // unique to a (both rows of a)
      mutant('m2', 1, ['a#1', 'b']),
      mutant('m3', 1, ['b'], 'timeout'),
      mutant('m4', 1, ['a#1'], 'survived'),
      mutant('m5', 1, [], 'killed'),
    ],
  });
  const r = report(doc);
  assert.deepEqual([unit(r, 'a').signals.kills, unit(r, 'a').signals.uniqueKills], [2, 1]);
  assert.deepEqual([unit(r, 'b').signals.kills, unit(r, 'b').signals.uniqueKills], [2, 1]);
});

test('S4 durations: median per row, floored mean for even counts, summed; runs is the smallest count', () => {
  const doc = input({
    tests: [
      t('a#1', { unit: 'a', durationsMs: [5, 1, 9] }), // 5
      t('a#2', { unit: 'a', durationsMs: [4, 7] }), // floor(5.5) = 5
      t('b', { durationsMs: undefined }),
    ],
  });
  delete doc.tests[2].durationsMs;
  const r = report(doc);
  assert.deepEqual([unit(r, 'a').signals.durationMs, unit(r, 'a').signals.runs], [10, 2]);
  assert.deepEqual([unit(r, 'b').signals.durationMs, unit(r, 'b').signals.runs], [0, 0]);
});

test('S5 brittle lists the sorted distinct kinds of the rows', () => {
  const doc = input({
    tests: [t('a#1', { unit: 'a' }), t('a#2', { unit: 'a' })],
    brittleness: [{ test: 'a#2', kind: 'source-text' }, { test: 'a#1', kind: 'css-class' }, { test: 'a#1', kind: 'source-text' }],
  });
  assert.deepEqual(unit(report(doc), 'a').signals.brittle, ['css-class', 'source-text']);
});

test('3.3 unit status: failed if any row failed, skipped if all skipped, else passed', () => {
  const doc = input({
    tests: [
      t('f#1', { unit: 'f' }), t('f#2', { unit: 'f', status: 'failed' }),
      t('s#1', { unit: 's', status: 'skipped' }), t('s#2', { unit: 's', status: 'skipped' }),
      t('p#1', { unit: 'p', status: 'skipped' }), t('p#2', { unit: 'p' }),
    ],
  });
  const r = report(doc);
  assert.deepEqual(['f', 's', 'p'].map((id) => unit(r, id).status), ['failed', 'skipped', 'passed']);
  assert.deepEqual(unit(r, 'f').rows, ['f#1', 'f#2']);
  assert.deepEqual(codes(r), []);
});

test('S6 similarity: shape Jaccard (0 when missing or both empty) and line Jaccard', () => {
  const sim = (a, b) => shapeSimilarity({ shape: a && new Set(a) }, { shape: b && new Set(b) });
  assert.deepEqual(sim([1, 2, 3], [2, 3, 4]), { num: 2, den: 4 });
  assert.equal(ratioAtLeast(...Object.values(sim(null, [1])), 0), true); // 0 >= 0
  assert.equal(ratioAtLeast(...Object.values(sim(null, [1])), 0.01), false);
  assert.deepEqual(sim([], []), { num: 0, den: 0 });
  assert.deepEqual(lineJaccard(mapFrom({ s: '1-4' }), mapFrom({ s: '3-6' })), { num: 2, den: 6 });
  assert.deepEqual(lineJaccard(mapFrom({}), mapFrom({})), { num: 0, den: 0 });
});
