#!/usr/bin/env node
// Builds spec/conformance/cases/ from the definitions below. The generated case files are the conformance
// suite; this script only keeps them maintainable. Every expected value here was worked out by hand from
// spec/SPEC.md, never produced by an engine.
//
// Usage:
//   node spec/conformance/build.mjs          write every case
//   node spec/conformance/build.mjs --check  exit 1 if any case on disk differs from its definition

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./cases/', import.meta.url));
const CHECK = process.argv.includes('--check');

// ---------- helpers ----------

const NODE22 = { name: 'node', version: '22.23.3' };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Builds an input. `cov` maps test id to a line set of `src` (default src/a.mjs) or to { source: lines }. */
function input({ sources = { 'src/a.mjs': { coverable: '1-10' } }, tests, cov = {}, setup, granularity = 'test', byFile, rechecked, unstable, mutation, brittleness, shapes, runtime = NODE22, runtimes, spec = 'cupel-spec/1' }) {
  const coverage = { granularity };
  if (granularity === 'test') {
    coverage.byTest = Object.fromEntries(Object.entries(cov).map(([id, v]) => [id, typeof v === 'string' ? { 'src/a.mjs': v } : v]));
  } else {
    coverage.byFile = byFile;
  }
  if (setup) coverage.setup = setup;
  if (rechecked) coverage.rechecked = rechecked;
  if (unstable) coverage.unstable = unstable;
  const out = { spec, kind: 'input', runtime, ...(runtimes ? { runtimes } : {}), sources, tests, coverage };
  if (mutation) out.mutation = mutation;
  if (brittleness) out.brittleness = brittleness;
  if (shapes) out.shapes = shapes;
  return out;
}

/** A test entry. */
const t = (id, file, name = id, extra = {}) => ({ id, file, name, status: 'passed', ...extra });

/** A mutant. */
const m = (id, line, status, killedBy, source = 'src/a.mjs') => {
  const mu = { id, source, line, operator: 'flip', status };
  if (killedBy) mu.killedBy = killedBy;
  return mu;
};

/** Parses "+I1 -T8 ..." into rule entries. */
const rules = (s) => s.trim().split(/\s+/).map((r) => ({ id: r.slice(1), polarity: r[0] === '+' ? 'positive' : 'negative' }));

const ADVICE0 = { keep: 0, consolidate: 0, rewrite: 0, 'move-to-check': 0, none: 0 };
const advice = (counts) => ({ ...ADVICE0, ...counts });
const NO_CRIT = { covered: 0, coverable: 0, pct: null };

const cases = [];
function kase(name, def) {
  cases.push({ name, ...def });
}

// ---------- input integrity (I) ----------

const SIMPLE_TESTS = [t('t1', 'tests/a.test.mjs', 'adds'), t('t2', 'tests/a.test.mjs', 'other')];

kase('001-report-minimal', {
  description: 'Two tests in one file share lines; setup lines are not own lines; both keep for their unique lines.',
  command: 'report',
  rules: rules('+I1 +I2 +I3 +S1 +S2 -S2 +A7 -A11 +R3 -R1 -R2 +T7 -T1 -T3 -T8 -A1 -A8 -A12 -E1'),
  input: input({ tests: SIMPLE_TESTS, cov: { t1: '1-4', t2: '3-6' }, setup: { 'tests/a.test.mjs': { 'src/a.mjs': '1' } } }),
  expectExit: 0,
  expected: {
    spec: 'cupel-spec/1',
    kind: 'report',
    command: 'report',
    generatedAt: '$absent',
    runtime: NODE22,
    diagnostics: [],
    suite: {
      tests: 2, units: 2, passed: 2, failed: 0, skipped: 0, durationMs: 0,
      coverage: { covered: 6, coverable: 10, pct: 60 },
      criticalCoverage: NO_CRIT,
      mutation: null,
      criticalMutation: null,
      advice: advice({ keep: 2 }),
    },
    units: [
      {
        id: 't1', file: 'tests/a.test.mjs', rows: ['t1'], tier: 'standard', tierReason: 'default', protected: false, status: 'passed',
        signals: { ownLines: 3, uniqueLines: 1, kills: 0, uniqueKills: 0, durationMs: 0, runs: 0, brittle: [] },
        advice: 'keep', reasons: ['unique-lines'], hints: [],
      },
      {
        id: 't2', file: 'tests/a.test.mjs', rows: ['t2'], tier: 'standard', tierReason: 'default', protected: false, status: 'passed',
        signals: { ownLines: 4, uniqueLines: 2, kills: 0, uniqueKills: 0, durationMs: 0, runs: 0, brittle: [] },
        advice: 'keep', reasons: ['unique-lines'], hints: [],
      },
    ],
    groups: [],
  },
});

kase('002-invalid-spec-version', {
  description: 'An input for another spec major is refused with exit 2.',
  command: 'report',
  rules: rules('-I1 +E1'),
  input: input({ spec: 'cupel-spec/2', tests: SIMPLE_TESTS, cov: { t1: '1' } }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'invalid-input', severity: 'error', path: '/spec' }], suite: '$absent', units: '$absent' },
});

kase('003-unknown-test', {
  description: 'Coverage for a test id that is not in tests is refused.',
  command: 'report',
  rules: rules('-I2 +E1'),
  input: input({ tests: SIMPLE_TESTS, cov: { t1: '1', ghost: '2' } }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'unknown-test', severity: 'error', test: 'ghost' }], units: '$absent' },
});

kase('004-unit-spans-files', {
  description: 'Rows of one unit must share a file.',
  command: 'report',
  rules: rules('-I2'),
  input: input({
    tests: [t('r1', 'tests/a.test.mjs', 'r1', { unit: 'u' }), t('r2', 'tests/b.test.mjs', 'r2', { unit: 'u' })],
    cov: { r1: '1', r2: '2' },
  }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'unit-spans-files', severity: 'error' }], units: '$absent' },
});

kase('005-line-not-coverable', {
  description: 'Covered lines outside the source\'s coverable lines are refused.',
  command: 'report',
  rules: rules('-I3'),
  input: input({ tests: SIMPLE_TESTS, cov: { t1: '9-12' } }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'line-not-coverable', severity: 'error' }], units: '$absent' },
});

kase('006-bad-range', {
  description: 'A range whose start is after its end is refused.',
  command: 'report',
  rules: rules('-I3'),
  input: input({ tests: SIMPLE_TESTS, cov: { t1: '5-3' } }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'bad-range', severity: 'error' }], units: '$absent' },
});

kase('007-unknown-source', {
  description: 'Coverage of a source that is not in sources is refused.',
  command: 'report',
  rules: rules('-I3'),
  input: input({ tests: SIMPLE_TESTS, cov: { t1: { 'src/zzz.mjs': '1' } } }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'unknown-source', severity: 'error' }], units: '$absent' },
});

// ---------- tiers (T) ----------

kase('008-tag-precedence', {
  description: 'Rows of one unit carry minor and critical tags: the most protective wins, over a minor path rule.',
  command: 'report',
  rules: rules('+T1 -T6 +T7'),
  config: { tiers: { minor: ['tests/x.test.mjs'] } },
  input: input({
    tests: [
      t('r1', 'tests/x.test.mjs', 'row one', { unit: 'table', tags: ['minor'] }),
      t('r2', 'tests/x.test.mjs', 'row two', { unit: 'table', tags: ['critical'] }),
      t('t3', 'tests/plain.test.mjs', 'plain'),
    ],
    cov: { r1: '1-2', r2: '3', t3: '5' },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 't3', tier: 'standard', tierReason: 'default', protected: false },
      { id: 'table', rows: ['r1', 'r2'], tier: 'critical', tierReason: 'tag', protected: true },
    ],
  },
});

kase('009-label-unknown-tag', {
  description: 'An unknown tag is an error diagnostic; label exits 1 and the tier is unaffected.',
  command: 'label',
  rules: rules('+T2 -L1'),
  input: input({ tests: [t('t1', 'tests/a.test.mjs', 'a', { tags: ['crit'] })], cov: { t1: '1' } }),
  expectExit: 1,
  expected: {
    command: 'label',
    diagnostics: [{ code: 'unknown-tag', severity: 'error', test: 't1' }],
    units: [{ id: 't1', tier: 'standard', tierReason: 'default', protected: false }],
  },
});

kase('010-label-path-rules', {
  description: 'Critical and minor globs decide tiers; protected follows critical.',
  command: 'label',
  rules: rules('+L1 -T2 +T3 +T6 +T8 -T7'),
  config: { tiers: { critical: ['tests/core/**'], minor: ['tests/docs-*.test.mjs'] } },
  input: input({
    tests: [t('a', 'tests/core/x.test.mjs'), t('b', 'tests/docs-copy.test.mjs'), t('c', 'tests/plain.test.mjs')],
    cov: { a: '1', b: '2', c: '3' },
  }),
  expectExit: 0,
  expected: {
    command: 'label',
    diagnostics: [],
    units: [
      { id: 'a', tier: 'critical', tierReason: 'path-rule', protected: true },
      { id: 'b', tier: 'minor', tierReason: 'path-rule', protected: false },
      { id: 'c', tier: 'standard', tierReason: 'default', protected: false },
    ],
  },
});

kase('011-critical-words', {
  description: 'Path words match whole tokens (multi-token and camelCase); title words match test names; "design" is not "sign-in".',
  command: 'label',
  rules: rules('+T4 -T4'),
  input: input({
    tests: [
      t('d', 'tests/design.test.mjs', 'renders the list'),
      t('f', 'tests/cookies.test.mjs', 'refuses a forged cookie'),
      t('l', 'tests/loginForm.test.mjs', 'renders'),
      t('s', 'tests/sign-in-flow.test.mjs', 'renders'),
    ],
    cov: { d: '1', f: '2', l: '3', s: '4' },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'd', tier: 'standard', tierReason: 'default' },
      { id: 'f', tier: 'critical', tierReason: 'critical-word' },
      { id: 'l', tier: 'critical', tierReason: 'critical-word' },
      { id: 's', tier: 'critical', tierReason: 'critical-word' },
    ],
  },
});

kase('012-unique-critical-lines', {
  description: 'Unique lines in a critical source make a unit critical; shared critical lines only protect it.',
  command: 'report',
  rules: rules('+T5 -T5 +T8'),
  input: input({
    sources: { 'src/billing/ledger.mjs': { coverable: '1-10' }, 'src/util.mjs': { coverable: '1-10' } },
    tests: [t('p', 'tests/p.test.mjs'), t('q', 'tests/q.test.mjs')],
    cov: { p: { 'src/billing/ledger.mjs': '1-5' }, q: { 'src/billing/ledger.mjs': '1-3', 'src/util.mjs': '1-4' } },
  }),
  expectExit: 0,
  expected: {
    suite: { coverage: { covered: 9, coverable: 20, pct: 45 }, criticalCoverage: { covered: 5, coverable: 10, pct: 50 } },
    units: [
      { id: 'p', tier: 'critical', tierReason: 'unique-critical-lines', protected: true, advice: 'keep', reasons: ['critical', 'unique-lines'] },
      { id: 'q', tier: 'standard', tierReason: 'default', protected: true, advice: 'keep', reasons: ['unique-lines'] },
    ],
  },
});

kase('013-word-beats-minor-glob', {
  description: 'A critical word in the file path outranks a minor glob.',
  command: 'label',
  rules: rules('-T6 +T6 +T4'),
  config: { tiers: { minor: ['tests/docs-*.test.mjs'] } },
  input: input({ tests: [t('v', 'tests/docs-faq.test.mjs'), t('w', 'tests/docs-secret.test.mjs')], cov: { v: '1', w: '2' } }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'v', tier: 'minor', tierReason: 'path-rule' },
      { id: 'w', tier: 'critical', tierReason: 'critical-word' },
    ],
  },
});

// ---------- signals (S) ----------

kase('014-setup-lines', {
  description: 'Own lines drop only the own file\'s setup; unique lines drop every file\'s setup.',
  command: 'report',
  rules: rules('+S1 -S1 +S2 -S2'),
  input: input({
    tests: [t('t1', 'tests/a.test.mjs'), t('t2', 'tests/b.test.mjs')],
    cov: { t1: '1-3,7', t2: '9' },
    setup: { 'tests/a.test.mjs': { 'src/a.mjs': '1' }, 'tests/b.test.mjs': { 'src/a.mjs': '7' } },
  }),
  expectExit: 0,
  expected: {
    suite: { coverage: { covered: 5, coverable: 10, pct: 50 } },
    units: [
      { id: 't1', signals: { ownLines: 3, uniqueLines: 2 } },
      { id: 't2', signals: { ownLines: 1, uniqueLines: 1 } },
    ],
  },
});

kase('015-kills', {
  description: 'Kills count detected mutants (killed or timeout); unique kills need a non-empty killedBy of one unit; errors are excluded from the score.',
  command: 'report',
  rules: rules('+S3 -S3 +A7 +R2'),
  input: input({
    tests: [t('t1', 'tests/a.test.mjs'), t('t2', 'tests/a.test.mjs')],
    cov: { t1: '1-5', t2: '1-5' },
    mutation: {
      mutants: [
        m('m1', 1, 'killed', ['t1', 't2']),
        m('m2', 2, 'killed', ['t1']),
        m('m3', 3, 'timeout', ['t2']),
        m('m4', 4, 'survived'),
        m('m5', 6, 'no-coverage'),
        m('m6', 5, 'error'),
      ],
    },
  }),
  expectExit: 0,
  expected: {
    suite: { mutation: { detected: 3, undetected: 2, score: 60 } },
    units: [
      { id: 't1', signals: { uniqueLines: 0, kills: 2, uniqueKills: 1 }, advice: 'keep', reasons: ['unique-kills'] },
      { id: 't2', signals: { uniqueLines: 0, kills: 2, uniqueKills: 1 }, advice: 'keep', reasons: ['unique-kills'] },
    ],
  },
});

kase('016-rows-and-durations', {
  description: 'Rows form one unit: durations are summed row medians (even counts round down), runs is the minimum; a mutant killed by two rows of one unit is unique to it.',
  command: 'report',
  rules: rules('+S4 -S4 +S3 -R3'),
  input: input({
    tests: [
      t('r1', 'tests/t.test.mjs', 'table [1]', { unit: 'table', durationsMs: [10, 31] }),
      t('r2', 'tests/t.test.mjs', 'table [2]', { unit: 'table', durationsMs: [5, 7, 100] }),
      t('t3', 'tests/t.test.mjs', 'single'),
    ],
    cov: { r1: '1-2', r2: '2-3', t3: '5' },
    mutation: { mutants: [m('mk', 2, 'killed', ['r1', 'r2'])] },
  }),
  expectExit: 0,
  expected: {
    suite: { tests: 3, units: 2, passed: 3, durationMs: 27 },
    units: [
      { id: 't3', rows: ['t3'], signals: { ownLines: 1, uniqueLines: 1, kills: 0, uniqueKills: 0, durationMs: 0, runs: 0 } },
      { id: 'table', rows: ['r1', 'r2'], signals: { ownLines: 3, uniqueLines: 3, kills: 1, uniqueKills: 1, durationMs: 27, runs: 2 } },
    ],
  },
});

kase('017-brittleness', {
  description: 'A non-deliberate pin means rewrite; only deliberate pins means move-to-check; a mix is still rewrite.',
  command: 'report',
  rules: rules('+S5 -S5 +A3 -A3 +A4 -A4'),
  input: input({
    tests: [t('t1', 'tests/a.test.mjs'), t('t2', 'tests/a.test.mjs'), t('t3', 'tests/a.test.mjs'), t('t4', 'tests/a.test.mjs')],
    cov: { t1: '1', t2: '2', t3: '3', t4: '4' },
    brittleness: [
      { test: 't1', kind: 'source-text' },
      { test: 't1', kind: 'css-class' },
      { test: 't2', kind: 'file-snapshot', deliberate: true },
      { test: 't3', kind: 'doc-wording', deliberate: true },
      { test: 't3', kind: 'css-class' },
    ],
  }),
  expectExit: 0,
  expected: {
    suite: { advice: advice({ keep: 1, rewrite: 2, 'move-to-check': 1 }) },
    units: [
      { id: 't1', signals: { brittle: ['css-class', 'source-text'] }, advice: 'rewrite', reasons: ['brittle:css-class', 'brittle:source-text'] },
      { id: 't2', signals: { brittle: ['file-snapshot'] }, advice: 'move-to-check', reasons: ['deliberate-pin'] },
      { id: 't3', signals: { brittle: ['css-class', 'doc-wording'] }, advice: 'rewrite', reasons: ['brittle:css-class', 'brittle:doc-wording'] },
      { id: 't4', signals: { brittle: [] }, advice: 'keep', reasons: ['unique-lines'] },
    ],
  },
});

// ---------- consolidation (A5, A9) ----------

const SHAPE_A = range(1, 10);
const SHAPE_B = [...range(1, 9), 11];
const SHAPE_C = [...range(1, 9), 12];

kase('018-consolidate-same-shape', {
  description: 'Same-file units with similar shapes and overlapping lines form a group; similar shape without shared lines, or another file, does not.',
  command: 'report',
  rules: rules('+A9 -A9 +A5 +S6 -A7 +A11'),
  input: input({
    sources: { 'src/a.mjs': { coverable: '1-30' } },
    tests: [t('a', 'tests/c.test.mjs'), t('b', 'tests/c.test.mjs'), t('c', 'tests/c.test.mjs'), t('d', 'tests/d.test.mjs')],
    cov: { a: '1-10', b: '1-8,11-12', c: '20-25', d: '1-10' },
    shapes: { a: SHAPE_A, b: SHAPE_B, c: SHAPE_C, d: SHAPE_A },
  }),
  expectExit: 0,
  expected: {
    suite: { advice: advice({ consolidate: 2, keep: 2 }) },
    units: [
      { id: 'a', advice: 'consolidate', reasons: ['same-shape'], group: 'g1' },
      { id: 'b', advice: 'consolidate', reasons: ['same-shape'], group: 'g1' },
      { id: 'c', advice: 'keep', reasons: ['unique-lines'], group: '$absent' },
      { id: 'd', signals: { uniqueLines: 0 }, advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] },
    ],
    groups: [{ id: 'g1', kind: 'same-shape', file: 'tests/c.test.mjs', units: ['a', 'b'] }],
  },
});

kase('019-consolidate-never-mixes-critical', {
  description: 'A critical unit never links with a non-critical one, however similar.',
  command: 'report',
  rules: rules('-A9'),
  input: input({
    tests: [t('e', 'tests/e.test.mjs', 'e', { tags: ['critical'] }), t('f', 'tests/e.test.mjs')],
    cov: { e: '1-5', f: '1-5' },
    shapes: { e: SHAPE_A, f: SHAPE_A },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'e', advice: 'keep', reasons: ['critical'] },
      { id: 'f', advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] },
    ],
    groups: [],
  },
});

kase('020-consolidate-off', {
  description: 'With advice.consolidate false no group forms.',
  command: 'report',
  rules: rules('-A9 -A5'),
  config: { advice: { consolidate: false } },
  input: input({
    sources: { 'src/a.mjs': { coverable: '1-30' } },
    tests: [t('a', 'tests/c.test.mjs'), t('b', 'tests/c.test.mjs')],
    cov: { a: '1-10', b: '1-8,11-12' },
    shapes: { a: SHAPE_A, b: SHAPE_B },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'a', advice: 'keep', reasons: ['unique-lines'] },
      { id: 'b', advice: 'keep', reasons: ['unique-lines'] },
    ],
    groups: [],
  },
});

kase('021-slow-low-value', {
  description: 'Slow (median >= 2000 ms over >= 2 runs) with fewer than 5 unique lines means rewrite; one run, enough unique lines, or critical does not.',
  command: 'report',
  rules: rules('+A6 -A6'),
  input: input({
    sources: { 'src/a.mjs': { coverable: '1-30' } },
    tests: [
      t('s1', 'tests/s.test.mjs', 's1', { durationsMs: [2500, 2600] }),
      t('s2', 'tests/s.test.mjs', 's2', { durationsMs: [3000] }),
      t('s3', 'tests/s.test.mjs', 's3', { durationsMs: [2100, 2200] }),
      t('s4', 'tests/s.test.mjs', 's4', { durationsMs: [5000, 5000], tags: ['critical'] }),
    ],
    cov: { s1: '1-3', s2: '4-6', s3: '7-12', s4: '13' },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 's1', signals: { durationMs: 2550, runs: 2, uniqueLines: 3 }, advice: 'rewrite', reasons: ['slow-low-value'] },
      { id: 's2', signals: { runs: 1 }, advice: 'keep', reasons: ['unique-lines'] },
      { id: 's3', signals: { uniqueLines: 6 }, advice: 'keep', reasons: ['unique-lines'] },
      { id: 's4', advice: 'keep', reasons: ['critical', 'unique-lines'] },
    ],
  },
});

// ---------- review candidates (A10; no retire in v1, D5) ----------

kase('022-review-candidate-mutation-path', {
  description: 'Rechecked, targeted, no unique line and no unique kill: a review candidate, kept with the no-unique-evidence hint, never retired.',
  command: 'report',
  rules: rules('+A10'),
  input: input({
    tests: [t('k', 'tests/k.test.mjs'), t('r', 'tests/r.test.mjs')],
    cov: { k: '1-6', r: '2-4' },
    rechecked: ['r'],
    mutation: { mutants: [m('m1', 3, 'killed', ['k', 'r'])], targeted: ['r'] },
  }),
  expectExit: 0,
  expected: {
    suite: { advice: advice({ keep: 2 }) },
    units: [
      { id: 'k', advice: 'keep', reasons: ['unique-lines'] },
      { id: 'r', advice: 'keep', reasons: [], hints: ['no-unique-evidence'], duplicateOf: '$absent' },
    ],
  },
});

kase('023-review-needs-evidence', {
  description: 'Without both the per-process recheck and targeted mutation (or a duplicate), no review candidate: keep with the unverified hint.',
  command: 'report',
  rules: rules('-A10 +A11'),
  input: input({
    tests: [t('k', 'tests/k.test.mjs'), t('r1', 'tests/r1.test.mjs'), t('r2', 'tests/r2.test.mjs')],
    cov: { k: '1-6', r1: '2-4', r2: '3' },
    rechecked: ['r1'],
    mutation: { mutants: [m('m1', 3, 'killed', ['k'])], targeted: ['r2'] },
  }),
  expectExit: 0,
  expected: {
    suite: { advice: advice({ keep: 3 }) },
    units: [
      { id: 'k', advice: 'keep', reasons: ['unique-lines', 'unique-kills'] },
      { id: 'r1', advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] },
      { id: 'r2', advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] },
    ],
  },
});

kase('024-unique-kill-keeps', {
  description: 'A unit with no unique line but a unique kill is kept for the kill.',
  command: 'report',
  rules: rules('-A10 +A7'),
  input: input({
    tests: [t('k', 'tests/k.test.mjs'), t('r', 'tests/r.test.mjs')],
    cov: { k: '1-6', r: '2-4' },
    rechecked: ['r'],
    mutation: { mutants: [m('m1', 2, 'killed', ['r'])], targeted: ['r'] },
  }),
  expectExit: 0,
  expected: { units: [{ id: 'k' }, { id: 'r', signals: { uniqueLines: 0, uniqueKills: 1 }, advice: 'keep', reasons: ['unique-kills'] }] },
});

kase('025-protected-never-a-candidate', {
  description: 'A unit covering a critical source is protected and never a review candidate, even with full evidence.',
  command: 'report',
  rules: rules('-A10 +T8'),
  input: input({
    sources: { 'src/auth.mjs': { coverable: '1-10' } },
    tests: [t('k', 'tests/k.test.mjs'), t('r', 'tests/r.test.mjs')],
    cov: { k: { 'src/auth.mjs': '1-6' }, r: { 'src/auth.mjs': '2-4' } },
    rechecked: ['r'],
    mutation: { mutants: [], targeted: ['r'] },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'k', tier: 'critical', tierReason: 'unique-critical-lines', advice: 'keep', reasons: ['critical', 'unique-lines'] },
      { id: 'r', tier: 'standard', protected: true, advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] },
    ],
  },
});

kase('026-review-candidate-duplicate-path', {
  description: 'A rechecked unit whose body duplicates another unit that covers all its lines is a review candidate naming the duplicate.',
  command: 'report',
  rules: rules('+A10'),
  input: input({
    tests: [t('r', 'tests/r.test.mjs'), t('v', 'tests/v.test.mjs')],
    cov: { r: '2-4', v: '1-6' },
    rechecked: ['r'],
    shapes: { r: SHAPE_A, v: SHAPE_A },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'r', advice: 'keep', reasons: [], hints: ['no-unique-evidence'], duplicateOf: 'v' },
      { id: 'v', advice: 'keep', reasons: ['unique-lines'] },
    ],
  },
});

kase('027-mutual-candidates', {
  description: 'Two units that cover each other are both review candidates: neither is advice to remove, so no joint pass is needed.',
  command: 'report',
  rules: rules('+A10'),
  input: input({
    tests: [t('x', 'tests/x.test.mjs', 'x', { durationsMs: [100, 100] }), t('y', 'tests/y.test.mjs', 'y', { durationsMs: [50, 50] })],
    cov: { x: '1-5', y: '1-5' },
    rechecked: ['x', 'y'],
    mutation: { mutants: [], targeted: ['x', 'y'] },
  }),
  expectExit: 0,
  expected: {
    suite: { advice: advice({ keep: 2 }) },
    units: [
      { id: 'x', advice: 'keep', reasons: [], hints: ['no-unique-evidence'] },
      { id: 'y', advice: 'keep', reasons: [], hints: ['no-unique-evidence'] },
    ],
  },
});

kase('028-no-coverage-evidence', {
  description: 'A unit with no own lines (only setup, or no coverage) gets no advice and a no-evidence hint.',
  command: 'report',
  rules: rules('+A8 -A8'),
  input: input({
    tests: [t('c1', 'tests/c.test.mjs'), t('c2', 'tests/c.test.mjs'), t('c3', 'tests/c.test.mjs')],
    cov: { c1: '1-2', c3: '5' },
    setup: { 'tests/c.test.mjs': { 'src/a.mjs': '1-2' } },
  }),
  expectExit: 0,
  expected: {
    suite: { advice: advice({ none: 2, keep: 1 }) },
    units: [
      { id: 'c1', signals: { ownLines: 0 }, advice: 'none', reasons: [], hints: ['no-coverage-evidence'] },
      { id: 'c2', signals: { ownLines: 0 }, advice: 'none', reasons: [], hints: ['no-coverage-evidence'] },
      { id: 'c3', advice: 'keep', reasons: ['unique-lines'], hints: [] },
    ],
  },
});

kase('029-failed-and-skipped', {
  description: 'Failed units get no advice; fully skipped units get no advice; a unit with a passed and a skipped row is passed.',
  command: 'report',
  rules: rules('+A1 +A2 -A2'),
  input: input({
    tests: [
      t('t1', 'tests/a.test.mjs', 't1', { status: 'failed' }),
      t('t2', 'tests/a.test.mjs', 't2', { status: 'skipped' }),
      t('u1', 'tests/a.test.mjs', 'u1', { unit: 'u' }),
      t('u2', 'tests/a.test.mjs', 'u2', { unit: 'u', status: 'skipped' }),
    ],
    cov: { t1: '1', u1: '2' },
  }),
  expectExit: 0,
  expected: {
    suite: { tests: 4, units: 3, passed: 1, failed: 1, skipped: 2, advice: advice({ none: 2, keep: 1 }) },
    units: [
      { id: 't1', status: 'failed', advice: 'none', reasons: ['failed'] },
      { id: 't2', status: 'skipped', advice: 'none', reasons: ['not-run'] },
      { id: 'u', status: 'passed', advice: 'keep', reasons: ['unique-lines'] },
    ],
  },
});

kase('030-low-evidence-hints', {
  description: 'End-to-end tests and tests that spawn an interpreter are flagged and never review candidates.',
  command: 'report',
  rules: rules('-A10'),
  input: input({
    tests: [
      t('e', 'tests/e2e.test.mjs', 'e', { kind: 'e2e' }),
      t('k', 'tests/k.test.mjs'),
      t('s', 'tests/s.test.mjs', 's', { spawnsInterpreter: true }),
    ],
    cov: { e: '2-3', k: '1-6', s: '7' },
    rechecked: ['e'],
    mutation: { mutants: [], targeted: ['e'] },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'e', advice: 'keep', reasons: [], hints: ['low-evidence', 'no-unique-coverage-unverified'] },
      { id: 'k', advice: 'keep', hints: [] },
      { id: 's', advice: 'keep', reasons: ['unique-lines'], hints: ['spawns-interpreter'] },
    ],
  },
});

kase('031-file-granularity', {
  description: 'At file granularity unit uniqueness is null, units are kept with a hint, and files report their unique lines.',
  command: 'report',
  rules: rules('+A12'),
  input: input({
    granularity: 'file',
    tests: [t('a1', 'tests/a.test.mjs'), t('b1', 'tests/b.test.mjs'), t('b2', 'tests/b.test.mjs', 'b2', { tags: ['critical'] })],
    byFile: { 'tests/a.test.mjs': { 'src/a.mjs': '1-5' }, 'tests/b.test.mjs': { 'src/a.mjs': '3-5' } },
  }),
  expectExit: 0,
  expected: {
    suite: { coverage: { covered: 5, coverable: 10, pct: 50 } },
    units: [
      { id: 'a1', signals: { uniqueLines: null, uniqueKills: null }, advice: 'keep', reasons: [], hints: ['file-granularity'] },
      { id: 'b1', signals: { uniqueLines: null, uniqueKills: null }, advice: 'keep', reasons: [], hints: ['file-granularity'] },
      { id: 'b2', advice: 'keep', reasons: ['critical'], hints: [] },
    ],
    files: [
      { file: 'tests/a.test.mjs', uniqueLines: 2, hints: [] },
      { file: 'tests/b.test.mjs', uniqueLines: 0, hints: ['file-no-unique-coverage'] },
    ],
  },
});

kase('032-no-shape-no-group', {
  description: 'Units without shapes have similarity 0 and never group, even with identical lines.',
  command: 'report',
  rules: rules('-S6 -A9'),
  input: input({ tests: [t('a', 'tests/c.test.mjs'), t('b', 'tests/c.test.mjs')], cov: { a: '1-5', b: '1-5' } }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'a', advice: 'keep', hints: ['no-unique-coverage-unverified'] },
      { id: 'b', advice: 'keep', hints: ['no-unique-coverage-unverified'] },
    ],
    groups: [],
  },
});

// ---------- plan (P) ----------

kase('033-plan-full', {
  description: 'Without changes: critical, then standard, then minor; each by duration, then id.',
  command: 'plan',
  rules: rules('+P1 -P2 +P3'),
  config: { tiers: { minor: ['tests/m.test.mjs'] } },
  input: input({
    tests: [
      t('c1', 'tests/c.test.mjs', 'c1', { tags: ['critical'], durationsMs: [30] }),
      t('c2', 'tests/c.test.mjs', 'c2', { tags: ['critical'], durationsMs: [10] }),
      t('m1', 'tests/m.test.mjs', 'm1', { durationsMs: [1] }),
      t('s1', 'tests/s.test.mjs', 's1', { durationsMs: [5] }),
      t('s2', 'tests/s.test.mjs', 's2', { durationsMs: [5] }),
    ],
    cov: { c1: '1', c2: '2', m1: '3', s1: '4', s2: '5' },
  }),
  expectExit: 0,
  expected: {
    command: 'plan',
    plan: {
      mode: 'full',
      order: [
        { id: 'c2', bucket: 'critical', durationMs: 10 },
        { id: 'c1', bucket: 'critical', durationMs: 30 },
        { id: 's1', bucket: 'standard', durationMs: 5 },
        { id: 's2', bucket: 'standard', durationMs: 5 },
        { id: 'm1', bucket: 'minor', durationMs: 1 },
      ],
      skipped: [],
      expectedMs: 51,
    },
  },
});

kase('034-plan-changed', {
  description: 'With changes: critical, then units affected by changed lines or a changed test file, then other standard units; unaffected minor units are skipped.',
  command: 'plan',
  rules: rules('+P2 -P1 -P3'),
  config: { tiers: { minor: ['tests/m.test.mjs', 'tests/n.test.mjs'] } },
  args: { changed: { 'src/a.mjs': '4', 'tests/m.test.mjs': '' } },
  input: input({
    tests: [
      t('a', 'tests/a.test.mjs', 'a', { durationsMs: [20] }),
      t('c', 'tests/c.test.mjs', 'c', { tags: ['critical'], durationsMs: [10] }),
      t('m', 'tests/m.test.mjs', 'm', { durationsMs: [1] }),
      t('n', 'tests/n.test.mjs', 'n', { durationsMs: [1] }),
      t('r', 'tests/r.test.mjs', 'r', { durationsMs: [5] }),
    ],
    cov: { a: '3-5', c: '1-2', m: '8', n: '9', r: '7' },
  }),
  expectExit: 0,
  expected: {
    plan: {
      mode: 'changed',
      order: [
        { id: 'c', bucket: 'critical', durationMs: 10 },
        { id: 'm', bucket: 'affected', durationMs: 1 },
        { id: 'a', bucket: 'affected', durationMs: 20 },
        { id: 'r', bucket: 'rest', durationMs: 5 },
      ],
      skipped: ['n'],
      expectedMs: 36,
    },
  },
});

// ---------- check (C) ----------

kase('035-check-no-unique-evidence', {
  description: 'A new test with unique lines adds value; one whose lines another test already covers gets the informational no-unique-evidence verdict, naming the closest test, and check still exits 0.',
  command: 'check',
  rules: rules('+C1 -C1 +C2 -C4'),
  args: { tests: ['new2', 'new1'] },
  input: input({
    tests: [t('new1', 'tests/n.test.mjs'), t('new2', 'tests/n.test.mjs'), t('old', 'tests/o.test.mjs'), t('other', 'tests/x.test.mjs')],
    cov: { new1: '7-8', new2: '2-4', old: '1-6', other: '2' },
  }),
  expectExit: 0,
  expected: {
    command: 'check',
    check: {
      verdicts: [
        { id: 'new1', verdict: 'adds-value', brittle: [], extend: '$absent' },
        { id: 'new2', verdict: 'no-unique-evidence', extend: 'old', brittle: [] },
      ],
    },
  },
});

kase('036-check-all-add-value', {
  description: 'Critical tests add value even without unique lines.',
  command: 'check',
  rules: rules('+C1 -C2'),
  args: { tests: ['crit', 'new1'] },
  input: input({
    tests: [t('crit', 'tests/n.test.mjs', 'crit', { tags: ['critical'] }), t('new1', 'tests/n.test.mjs'), t('old', 'tests/o.test.mjs')],
    cov: { crit: '2-3', new1: '7-8', old: '1-6' },
  }),
  expectExit: 0,
  expected: { check: { verdicts: [{ id: 'crit', verdict: 'adds-value' }, { id: 'new1', verdict: 'adds-value' }] } },
});

const W_TESTS = [t('o', 'tests/o.test.mjs'), t('w', 'tests/w.test.mjs')];

kase('037-check-weakens', {
  description: 'Against a base, a test that lost own lines or a kill weakens the suite, even though it still has unique lines.',
  command: 'check',
  rules: rules('+C3'),
  args: { tests: ['w'] },
  base: input({ tests: W_TESTS, cov: { o: '1-2', w: '1-5' }, mutation: { mutants: [m('m1', 4, 'killed', ['w'])] } }),
  head: input({ tests: W_TESTS, cov: { o: '1-2', w: '1-3' }, mutation: { mutants: [m('m1', 4, 'survived')] } }),
  expectExit: 1,
  expected: { check: { verdicts: [{ id: 'w', verdict: 'weakens', lost: { lines: { 'src/a.mjs': '4-5' }, mutants: ['m1'] } }] } },
});

kase('038-check-not-weakened', {
  description: 'A test that gained lines against its base does not weaken the suite.',
  command: 'check',
  rules: rules('-C3'),
  args: { tests: ['w'] },
  base: input({ tests: W_TESTS, cov: { o: '1-2', w: '1-3' } }),
  head: input({ tests: W_TESTS, cov: { o: '1-2', w: '1-5' } }),
  expectExit: 0,
  expected: { check: { verdicts: [{ id: 'w', verdict: 'adds-value' }] } },
});

kase('039-check-fails-not-run', {
  description: 'Failed and skipped tests get fails and not-run, and check exits 1.',
  command: 'check',
  rules: rules('+C4'),
  args: { tests: ['f', 's'] },
  input: input({
    tests: [t('f', 'tests/f.test.mjs', 'f', { status: 'failed' }), t('s', 'tests/f.test.mjs', 's', { status: 'skipped' })],
    cov: { f: '1' },
  }),
  expectExit: 1,
  expected: { check: { verdicts: [{ id: 'f', verdict: 'fails' }, { id: 's', verdict: 'not-run' }] } },
});

// ---------- guard (G) ----------

const G_SOURCES = { 'src/a.mjs': { coverable: '1-10', hash: 'hb' }, 'src/auth.mjs': { coverable: '1-10', hash: 'ha' } };
const G_TESTS = [t('d', 'tests/d.test.mjs'), t('k', 'tests/k.test.mjs', 'k', { tags: ['critical'] }), t('x', 'tests/x.test.mjs')];
const G_COV = { d: '1-2', k: { 'src/auth.mjs': '1-4' }, x: '1-3' };
const gBase = (over = {}) => input({
  sources: G_SOURCES, tests: G_TESTS, cov: G_COV,
  mutation: { mutants: [m('m1', 2, 'killed', ['k'], 'src/auth.mjs'), m('m2', 1, 'killed', ['d', 'x'])] },
  ...over,
});
const CHECKS = ['head-passes', 'coverage-lines', 'coverage-ratio', 'critical-coverage', 'critical-mutation', 'critical-removed', 'critical-downgraded'];
const checks = (failing = {}) => CHECKS.map((id) => ({ id, pass: !(id in failing), ...(failing[id] ?? {}) }));

kase('040-guard-pass', {
  description: 'Removing a standard unit whose lines and kills another unit keeps passes every check and lists the removed unit with its evidence.',
  command: 'guard',
  rules: rules('+G1 +G3 +G4 +G5 +G6 +G7 +G8 +G9 -E1'),
  base: gBase(),
  head: gBase({
    tests: G_TESTS.filter((x) => x.id !== 'd'),
    cov: { k: G_COV.k, x: G_COV.x },
    mutation: { mutants: [m('m1', 2, 'killed', ['k'], 'src/auth.mjs'), m('m2', 1, 'killed', ['x'])] },
  }),
  expectExit: 0,
  expected: {
    command: 'guard',
    diagnostics: [],
    guard: { pass: true, checks: checks(), removed: [{ id: 'd', tier: 'standard', uniqueLines: 0, uniqueKills: 0 }] },
  },
});

kase('041-guard-coverage-lost', {
  description: 'Removing the only unit that covered a line fails the line check and the ratio check.',
  command: 'guard',
  rules: rules('-G4 +G9'),
  base: gBase(),
  head: gBase({
    tests: G_TESTS.filter((x) => x.id !== 'x'),
    cov: { d: G_COV.d, k: G_COV.k },
    mutation: { mutants: [m('m1', 2, 'killed', ['k'], 'src/auth.mjs'), m('m2', 1, 'killed', ['d'])] },
  }),
  expectExit: 1,
  expected: {
    guard: {
      pass: false,
      checks: checks({
        'coverage-lines': { lost: { lines: { 'src/a.mjs': '3' } } },
        'coverage-ratio': { base: { covered: 7, coverable: 20, pct: 35 }, head: { covered: 6, coverable: 20, pct: 30 } },
      }),
      removed: [{ id: 'x', tier: 'standard', uniqueLines: 1, uniqueKills: 0 }],
    },
  },
});

kase('042-guard-source-changed', {
  description: 'A source whose hash changed is not compared line by line; the overall ratio is compared as an exact fraction (5/10 = 4/8 passes).',
  command: 'guard',
  rules: rules('+G4 -G9'),
  base: input({ sources: { 'src/a.mjs': { coverable: '1-10', hash: 'h1' } }, tests: [t('d', 'tests/d.test.mjs')], cov: { d: '1-5' } }),
  head: input({ sources: { 'src/a.mjs': { coverable: '1-8', hash: 'h2' } }, tests: [t('d', 'tests/d.test.mjs')], cov: { d: '1-4' } }),
  expectExit: 0,
  expected: { guard: { pass: true, checks: checks(), removed: [] } },
});

kase('043-guard-critical-mutant-lost', {
  description: 'A mutant on a critical source detected at base and surviving at head fails the guard.',
  command: 'guard',
  rules: rules('-G6'),
  base: gBase(),
  head: gBase({ mutation: { mutants: [m('m1', 2, 'survived', undefined, 'src/auth.mjs'), m('m2', 1, 'killed', ['d', 'x'])] } }),
  expectExit: 1,
  expected: { guard: { pass: false, checks: checks({ 'critical-mutation': { lost: { mutants: ['m1'] } } }), removed: [] } },
});

kase('044-guard-critical-mutation-missing', {
  description: 'Base has critical mutants and head has no mutation data: missing data is never a pass.',
  command: 'guard',
  rules: rules('-G6'),
  base: gBase(),
  head: gBase({ mutation: undefined }),
  expectExit: 1,
  expected: { guard: { pass: false, checks: checks({ 'critical-mutation': { missing: true } }) } },
});

const K_TESTS = [t('k', 'tests/k.test.mjs', 'k', { tags: ['critical'] }), t('k2', 'tests/k2.test.mjs', 'k2', { tags: ['critical'] })];
const kBase = () => input({
  sources: { 'src/core.mjs': { coverable: '1-10', hash: 'hc' } },
  tests: K_TESTS,
  cov: { k: { 'src/core.mjs': '1-4' }, k2: { 'src/core.mjs': '1-4' } },
});
const kHeadWithout = () => input({ sources: { 'src/core.mjs': { coverable: '1-10', hash: 'hc' } }, tests: [K_TESTS[1]], cov: { k2: { 'src/core.mjs': '1-4' } } });

kase('045-guard-critical-removed', {
  description: 'Removing a critical unit without an approval fails, even when another unit covers the same lines.',
  command: 'guard',
  rules: rules('-G7'),
  base: kBase(),
  head: kHeadWithout(),
  expectExit: 1,
  expected: {
    guard: {
      pass: false,
      checks: checks({ 'critical-removed': { units: ['k'] } }),
      removed: [{ id: 'k', tier: 'critical', uniqueLines: 0, uniqueKills: 0 }],
    },
  },
});

kase('046-guard-critical-removed-approved', {
  description: 'The same removal passes with a person\'s approval.',
  command: 'guard',
  rules: rules('+G7'),
  args: { approvals: [{ action: 'remove', id: 'k', by: 'owner' }] },
  base: kBase(),
  head: kHeadWithout(),
  expectExit: 0,
  expected: { guard: { pass: true, checks: checks() } },
});

kase('047-guard-critical-downgraded', {
  description: 'A unit critical at base and standard at head needs a downgrade approval.',
  command: 'guard',
  rules: rules('-G8'),
  base: kBase(),
  head: input({
    sources: { 'src/core.mjs': { coverable: '1-10', hash: 'hc' } },
    tests: [t('k', 'tests/k.test.mjs'), K_TESTS[1]],
    cov: { k: { 'src/core.mjs': '1-4' }, k2: { 'src/core.mjs': '1-4' } },
  }),
  expectExit: 1,
  expected: { guard: { pass: false, checks: checks({ 'critical-downgraded': { units: ['k'] } }), removed: [] } },
});

kase('048-guard-runtime-mismatch', {
  description: 'Base and head from different runtime versions are never compared: exit 3.',
  command: 'guard',
  rules: rules('-G1 +E1'),
  base: gBase(),
  head: gBase({ runtime: { name: 'node', version: '26.7.0' } }),
  expectExit: 3,
  expected: { diagnostics: [{ code: 'runtime-mismatch', severity: 'error' }], guard: '$absent' },
});

kase('049-guard-head-fails', {
  description: 'A failing unit at head fails the head-passes check even when coverage holds.',
  command: 'guard',
  rules: rules('-G3'),
  base: gBase(),
  head: gBase({ tests: G_TESTS.map((x) => (x.id === 'x' ? { ...x, status: 'failed' } : x)) }),
  expectExit: 1,
  expected: { guard: { pass: false, checks: checks({ 'head-passes': { units: ['x'], preexisting: [] } }) } },
});

kase('056-guard-preexisting-failure', {
  description: 'A unit that fails at both base and head is pre-existing: it is listed but does not fail the guard.',
  command: 'guard',
  rules: rules('+G3'),
  base: gBase({ tests: G_TESTS.map((x) => (x.id === 'x' ? { ...x, status: 'failed' } : x)) }),
  head: gBase({ tests: G_TESTS.map((x) => (x.id === 'x' ? { ...x, status: 'failed' } : x)) }),
  expectExit: 0,
  expected: { guard: { pass: true, checks: checks({}).map((c) => (c.id === 'head-passes' ? { ...c, units: [], preexisting: ['x'] } : c)) } },
});

kase('057-guard-unstable-lines', {
  description: 'A line covered at base but not at head is not lost when it is unstable (covered in some runs only).',
  command: 'guard',
  rules: rules('+G4'),
  base: gBase(),
  head: gBase({ cov: { ...G_COV, x: '1-2' }, unstable: { 'src/a.mjs': '3' } }),
  expectExit: 0,
  expected: { guard: { pass: true, checks: checks(), removed: [], renamed: [] } },
});

const R_SRC = { 'src/core.mjs': { coverable: '1-10', hash: 'hc' } };
const rInput = (id, name, shape) => input({
  sources: R_SRC,
  tests: [t(id, 'tests/k.test.mjs', name, { tags: ['critical'] }), t('k2', 'tests/k2.test.mjs', 'k2', { tags: ['critical'] })],
  cov: { [id]: { 'src/core.mjs': '1-4' }, k2: { 'src/core.mjs': '1-4' } },
  shapes: { [id]: shape, k2: SHAPE_C },
});

kase('058-guard-critical-renamed', {
  description: 'A critical test renamed in the same file with a near-identical body is a rename, not a removal: no approval needed.',
  command: 'guard',
  rules: rules('+G7 +G9'),
  base: rInput('kold', 'k old', SHAPE_A),
  head: rInput('knew', 'k new', SHAPE_A),
  expectExit: 0,
  expected: { guard: { pass: true, checks: checks(), removed: [], renamed: [{ from: 'kold', to: 'knew' }] } },
});

kase('059-guard-rename-too-different', {
  description: 'A replacement whose body differs is not a rename: removing the critical test still needs approval.',
  command: 'guard',
  rules: rules('-G7 -G9'),
  base: rInput('kold', 'k old', SHAPE_A),
  head: rInput('knew', 'k new', range(21, 30)),
  expectExit: 1,
  expected: {
    guard: {
      pass: false,
      checks: checks({ 'critical-removed': { units: ['kold'] } }),
      removed: [{ id: 'kold', tier: 'critical', uniqueLines: 0, uniqueKills: 0 }],
      renamed: [],
    },
  },
});

const MR_SOURCES = { 'src/a.mjs': { coverable: '1-10', hash: 'ha' }, 'pkg/b.py': { coverable: '1-10', hash: 'hb' } };
const MR_TESTS = [t('tests/a.test.mjs::a', 'tests/a.test.mjs', 'a', { runner: 'vitest' }), t('tests/test_b.py::test_b', 'tests/test_b.py', 'test_b', { runner: 'pytest' })];
const MR_COV = { 'tests/a.test.mjs::a': { 'src/a.mjs': '1-4' }, 'tests/test_b.py::test_b': { 'pkg/b.py': '1-3' } };
const mrRuntimes = (py) => [{ runner: 'vitest', name: 'node', version: '22.23.3' }, { runner: 'pytest', name: 'python', version: py }];
const mrInput = (py, tests = MR_TESTS) => input({ sources: MR_SOURCES, tests, cov: MR_COV, runtimes: mrRuntimes(py) });

kase('060-report-several-runners', {
  description: 'One input from two runners: the engine scores them together and the report lists both runtimes.',
  command: 'report',
  rules: rules('+I2 -R1'),
  input: mrInput('3.13.1'),
  expectExit: 0,
  expected: {
    runtime: NODE22,
    runtimes: mrRuntimes('3.13.1'),
    suite: { tests: 2, units: 2, coverage: { covered: 7, coverable: 20, pct: 35 } },
  },
});

kase('061-guard-several-runners', {
  description: 'Guard across two runners with the same runtimes passes.',
  command: 'guard',
  rules: rules('+G1'),
  base: mrInput('3.13.1'),
  head: mrInput('3.13.1'),
  expectExit: 0,
  expected: { guard: { pass: true } },
});

kase('062-guard-runner-version-mismatch', {
  description: 'One runner changed version between base and head: guard refuses to compare.',
  command: 'guard',
  rules: rules('-G1 +E1'),
  base: mrInput('3.13.1'),
  head: mrInput('3.13.2'),
  expectExit: 3,
  expected: { diagnostics: [{ code: 'runtime-mismatch', severity: 'error' }], guard: '$absent' },
});

kase('063-unknown-runner', {
  description: 'With runtimes listed, a test naming an unlisted runner is refused.',
  command: 'report',
  rules: rules('-I2'),
  input: mrInput('3.13.1', [MR_TESTS[0], { ...MR_TESTS[1], runner: 'cargo' }]),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'unknown-runner', severity: 'error' }], units: '$absent' },
});

kase('050-guard-critical-coverage-target', {
  description: 'With a numeric critical coverage target, a critical source below it fails even when nothing changed.',
  command: 'guard',
  rules: rules('-G5'),
  config: { guard: { criticalCoverage: 100 } },
  base: gBase(),
  head: gBase(),
  expectExit: 1,
  expected: { guard: { pass: false, checks: checks({ 'critical-coverage': { sources: ['src/auth.mjs'] } }) } },
});

// ---------- report (R) ----------

kase('051-ratios-and-timestamp', {
  description: 'Ratios round down to two decimals; the timestamp appears only when passed as an argument.',
  command: 'report',
  rules: rules('+R1 +R2 -R2'),
  args: { generatedAt: '2026-10-21T00:00:00Z' },
  input: input({ sources: { 'src/a.mjs': { coverable: '1-3' } }, tests: [t('t', 'tests/t.test.mjs')], cov: { t: '1-2' } }),
  expectExit: 0,
  expected: {
    generatedAt: '2026-10-21T00:00:00Z',
    suite: { coverage: { covered: 2, coverable: 3, pct: 66.66 }, criticalCoverage: NO_CRIT },
  },
});

// ---------- readings settled with the independent engine ----------

kase('052-candidates-trust-passed-units', {
  description: 'A failing test\'s coverage is not trusted: a unit whose lines only a failing test also covers is not a review candidate.',
  command: 'report',
  rules: rules('-A10 +A1'),
  input: input({
    tests: [t('f', 'tests/f.test.mjs', 'f', { status: 'failed' }), t('r', 'tests/r.test.mjs')],
    cov: { f: '1-6', r: '2-4' },
    rechecked: ['r'],
    mutation: { mutants: [], targeted: ['r'] },
  }),
  expectExit: 0,
  expected: {
    units: [
      { id: 'f', advice: 'none', reasons: ['failed'] },
      { id: 'r', signals: { uniqueLines: 0 }, advice: 'keep', reasons: [], hints: ['no-unique-coverage-unverified'] },
    ],
  },
});

const AGG = (bCoverable, bHash) => input({
  sources: { 'src/auth-a.mjs': { coverable: '1-10', hash: 'a1' }, 'src/auth-b.mjs': { coverable: bCoverable, hash: bHash } },
  tests: [t('k', 'tests/k.test.mjs')],
  cov: { k: { 'src/auth-a.mjs': '1-10' } },
});

kase('053-guard-critical-aggregate', {
  description: 'Each critical source holds its ratio, but uncovered critical code grew: the aggregate falls and the guard fails.',
  command: 'guard',
  rules: rules('-G5 -G4'),
  base: AGG('1-10', 'b1'),
  head: AGG('1-30', 'b2'),
  expectExit: 1,
  expected: {
    guard: {
      pass: false,
      checks: checks({
        'coverage-ratio': { base: { covered: 10, coverable: 20, pct: 50 }, head: { covered: 10, coverable: 40, pct: 25 } },
        'critical-coverage': {},
      }),
      removed: [],
    },
  },
});

kase('054-invalid-config-empty-word', {
  description: 'A tier word with no letters or digits would match every path, so the config is refused.',
  command: 'report',
  rules: rules('-I1'),
  config: { tiers: { extraPathWords: ['-'] } },
  input: input({ tests: SIMPLE_TESTS, cov: { t1: '1' } }),
  expectExit: 2,
  expected: { diagnostics: [{ code: 'invalid-config', severity: 'error', path: '/tiers/extraPathWords/0' }], units: '$absent' },
});

kase('055-check-weakens-without-head-mutation', {
  description: 'When head has no mutation data, every mutant the test detected at base counts as lost.',
  command: 'check',
  rules: rules('+C3'),
  args: { tests: ['w'] },
  base: input({ tests: W_TESTS, cov: { o: '1-2', w: '1-5' }, mutation: { mutants: [m('m1', 4, 'killed', ['w'])] } }),
  head: input({ tests: W_TESTS, cov: { o: '1-2', w: '1-5' } }),
  expectExit: 1,
  expected: { check: { verdicts: [{ id: 'w', verdict: 'weakens', lost: { lines: {}, mutants: ['m1'] } }] } },
});

// ---------- write ----------

function filesFor(c) {
  const files = {};
  const caseJson = { description: c.description, command: c.command, rules: c.rules };
  if (c.args) caseJson.args = c.args;
  caseJson.expectExit = c.expectExit;
  files['case.json'] = caseJson;
  if (c.input) files['input.json'] = c.input;
  if (c.base) files['base.json'] = c.base;
  if (c.head) files['head.json'] = c.head;
  if (c.config) files['config.json'] = c.config;
  files['expected.json'] = c.expected;
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v, null, 2) + '\n']));
}

let stale = 0;
const wanted = new Set(cases.map((c) => c.name));
if (new Set(cases.map((c) => c.name)).size !== cases.length) throw new Error('duplicate case name');
if (!CHECK) mkdirSync(OUT, { recursive: true });
for (const dir of existsSync(OUT) ? readdirSync(OUT) : []) {
  if (!wanted.has(dir)) {
    if (CHECK) { console.error(`stale case directory: ${dir}`); stale++; } else rmSync(join(OUT, dir), { recursive: true });
  }
}
for (const c of cases) {
  const dir = join(OUT, c.name);
  const files = filesFor(c);
  if (CHECK) {
    const onDisk = existsSync(dir) ? readdirSync(dir).sort() : [];
    if (JSON.stringify(onDisk) !== JSON.stringify(Object.keys(files).sort())) { console.error(`files differ: ${c.name}`); stale++; continue; }
    for (const [f, text] of Object.entries(files)) {
      if (readFileSync(join(dir, f), 'utf8') !== text) { console.error(`out of date: ${c.name}/${f}`); stale++; }
    }
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  }
}
if (CHECK && stale) { console.error(`conformance cases out of date: run node spec/conformance/build.mjs`); process.exitCode = 1; }
else console.log(`${CHECK ? 'checked' : 'wrote'} ${cases.length} cases`);
