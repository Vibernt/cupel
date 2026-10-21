// R1-R3 (report), E1 (exit codes), config defaults, and a seeded sweep proving determinism and
// schema validity for every command over many generated inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, input, t, report, mutant, schemas } from './engine-helpers.mjs';
import { run, SPEC_VERSION, COMMANDS } from '../src/engine/index.mjs';
import { effectiveConfig } from '../src/engine/config.mjs';

const sample = () => input({
  sources: { 'src/a.mjs': { coverable: '1-10' }, 'src/token.mjs': { coverable: '1-3' } },
  tests: [
    t('b', { durationsMs: [4, 6] }),
    t('a#2', { unit: 'a', status: 'failed' }),
    t('a#1', { unit: 'a' }),
    t('c', { status: 'skipped' }),
  ],
  cov: { b: { 'src/a.mjs': '1-4', 'src/token.mjs': '1' }, 'a#1': { 'src/a.mjs': '3' } },
  mutants: [
    mutant('m1', 1, ['b']), mutant('m2', 2, [], 'survived'), mutant('m3', 3, [], 'no-coverage'),
    mutant('m4', 4, [], 'error'), mutant('m5', 1, ['b'], 'timeout', 'src/token.mjs'),
  ],
});

test('R1 keys follow the report schema order, at every level', () => {
  const r = report(sample(), {}, { generatedAt: '2026-10-21T00:00:00Z' });
  assert.deepEqual(Object.keys(r.report), ['spec', 'kind', 'command', 'generatedAt', 'runtime', 'diagnostics', 'suite', 'units', 'groups']);
  assert.deepEqual(Object.keys(r.report.suite), schemas.report.properties.suite.required);
  assert.deepEqual(Object.keys(r.report.units[0]), ['id', 'file', 'rows', 'tier', 'tierReason', 'protected', 'status', 'signals', 'advice', 'reasons', 'hints']);
  assert.deepEqual(Object.keys(r.report.units[0].signals), ['ownLines', 'uniqueLines', 'kills', 'uniqueKills', 'durationMs', 'runs', 'brittle']);
  assert.equal(r.report.spec, SPEC_VERSION);
  assert.equal(r.report.kind, 'report');
});

test('R1 generatedAt appears only when passed', () => {
  assert.equal('generatedAt' in report(sample()).report, false);
  assert.equal(report(sample(), {}, { generatedAt: 'then' }).report.generatedAt, 'then');
});

test('R1 units sorted by id, rows sorted', () => {
  const r = report(sample());
  assert.deepEqual(r.report.units.map((u) => u.id), ['a', 'b', 'c']);
  assert.deepEqual(r.report.units[0].rows, ['a#1', 'a#2']);
});

test('R1 the same call twice gives byte-identical JSON, whatever the input order', () => {
  const a = sample();
  const b = sample();
  b.tests.reverse();
  b.mutation.mutants.reverse();
  b.coverage.byTest = Object.fromEntries(Object.entries(b.coverage.byTest).reverse());
  for (const cmd of ['report', 'label', 'plan']) {
    assert.equal(JSON.stringify(go(cmd, { input: a }).report), JSON.stringify(go(cmd, { input: b }).report), cmd);
  }
});

test('R2/R3 suite totals', () => {
  const s = report(sample()).report.suite;
  assert.deepEqual(s, {
    tests: 4, units: 3, passed: 2, failed: 1, skipped: 1, durationMs: 35,
    coverage: { covered: 5, coverable: 13, pct: 38.46 },
    criticalCoverage: { covered: 1, coverable: 3, pct: 33.33 },
    mutation: { detected: 2, undetected: 2, score: 50 },
    criticalMutation: { detected: 1, undetected: 0, score: 100 },
    advice: { keep: 1, consolidate: 0, rewrite: 0, 'move-to-check': 0, retire: 0, none: 2 },
  });
});

test('R2/R3 no mutation data: mutation scores are null; nothing coverable: pct null', () => {
  const s = report(input({ sources: {}, tests: [t('a')] })).report.suite;
  assert.equal(s.mutation, null);
  assert.equal(s.criticalMutation, null);
  assert.deepEqual(s.coverage, { covered: 0, coverable: 0, pct: null });
});

test('E1 exit codes: 0 ok, 1 failed check, 2 invalid, 3 environment', () => {
  assert.equal(report(sample()).exit, 0);
  assert.equal(go('check', { input: sample() }, {}, { tests: ['a'] }).exit, 1);
  assert.equal(report({ nope: true }).exit, 2);
  const head = sample();
  head.runtime.name = 'bun';
  assert.equal(go('guard', { base: sample(), head }).exit, 3);
});

test('validate runs I1-I3 only', () => {
  const r = go('validate', { input: sample() });
  assert.equal(r.exit, 0);
  assert.deepEqual(Object.keys(r.report), ['spec', 'kind', 'command', 'runtime', 'diagnostics']);
});

test('config defaults come from config.schema.json', () => {
  const c = effectiveConfig({ advice: { slowMs: 10 } }, schemas.config);
  assert.equal(c.advice.slowMs, 10);
  assert.equal(c.advice.shapeSimilarity, 0.8);
  assert.equal(c.guard.criticalCoverage, 'ratchet');
  assert.deepEqual(c.tiers.critical, []);
  assert.ok(c.words.path.includes('migrat'));
  assert.ok(c.words.title.includes('forged'));
});

// A tiny seeded generator (the tests may use randomness; the engine may not).
function lcg(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

function generated(seed) {
  const r = lcg(seed);
  const sources = {};
  const names = ['src/a.mjs', 'src/auth/session.mjs', 'src/util.mjs', 'lib/billing.mjs'];
  for (const n of names) sources[n] = { coverable: `1-${20 + r(30)}`, ...(r(2) ? { hash: `h${r(3)}` } : {}) };
  const files = ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/ui/c.test.mjs'];
  const tests = [];
  const byTest = {};
  const n = 3 + r(10);
  for (let i = 0; i < n; i++) {
    const unitId = `u${r(n + 3)}`;
    const id = `${unitId}#${i}`;
    const file = files[Number(unitId.slice(1)) % files.length];
    const statuses = ['passed', 'passed', 'passed', 'failed', 'skipped'];
    const row = { id, file, name: ['plain', 'refuses forged token', 'renders'][r(3)], unit: unitId, status: statuses[r(5)] };
    if (r(3)) row.durationsMs = Array.from({ length: r(4) }, () => r(4000));
    if (r(6) === 0) row.tags = [['critical', 'minor', 'standard', 'wip'][r(4)]];
    if (r(8) === 0) row.kind = 'e2e';
    if (r(8) === 0) row.spawnsInterpreter = true;
    tests.push(row);
    const cov = {};
    for (const [k, s] of names.entries()) if (r(k % 2 ? 6 : 2) === 0) { const a = 1 + r(4); cov[s] = `${a}-${a + r(5)},${1 + r(15)}`; }
    byTest[id] = cov;
  }
  const units = [...new Set(tests.map((x) => x.unit))];
  const mutants = Array.from({ length: r(6) }, (_, i) => ({
    id: `m${i}`, source: names[r(4)], line: 1 + r(15), operator: 'op',
    status: ['killed', 'survived', 'timeout', 'no-coverage', 'error'][r(5)],
    killedBy: tests.filter(() => r(3) === 0).map((x) => x.id),
  }));
  const shapes = Object.fromEntries(units.filter(() => r(3)).map((u) => [u, Array.from({ length: 5 }, () => r(5))]));
  return {
    spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '22' }, sources, tests,
    coverage: { granularity: r(5) ? 'test' : 'file', byTest, setup: { 'tests/a.test.mjs': { 'src/util.mjs': '1-2' } }, rechecked: units.filter(() => r(4)), ...(r(5) === 0 ? { byFile: { 'tests/b.test.mjs': { 'src/a.mjs': '1-9' } } } : {}) },
    ...(r(4) ? { mutation: { mutants, targeted: units.filter(() => r(4)) } } : {}),
    brittleness: tests.filter(() => r(6) === 0).map((x) => ({ test: x.id, kind: 'css-class', ...(r(2) ? { deliberate: true } : {}) })),
    shapes,
  };
}

/** The input with the given units deleted, as a person following the advice would. */
function without(doc, unitIds) {
  const d = JSON.parse(JSON.stringify(doc));
  const gone = new Set(d.tests.filter((x) => unitIds.has(x.unit ?? x.id)).map((x) => x.id));
  d.tests = d.tests.filter((x) => !gone.has(x.id));
  for (const id of gone) delete d.coverage.byTest[id];
  d.coverage.rechecked = d.coverage.rechecked.filter((u) => !unitIds.has(u));
  if (d.mutation) {
    d.mutation.targeted = d.mutation.targeted.filter((u) => !unitIds.has(u));
    for (const m of d.mutation.mutants) m.killedBy = m.killedBy.filter((id) => !gone.has(id));
  }
  d.brittleness = d.brittleness.filter((b) => !gone.has(b.test));
  for (const u of unitIds) delete d.shapes[u];
  return d;
}

test('seeded sweep: every command is deterministic and schema-valid on generated inputs', () => {
  const exits = new Set();
  const seen = new Set();
  let retiredSeen = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const doc = generated(seed);
    const other = generated(seed + 1000);
    other.runtime = doc.runtime;
    const unitIds = [...new Set(doc.tests.map((x) => x.unit))];
    const config = { tiers: { critical: ['lib/**'], minor: ['tests/ui/**'] }, advice: { shapeSimilarity: 0.5, duplicateShape: 0.6, slowMs: 1000 } };
    for (const [cmd, inputs, args] of [
      ['report', { input: doc }, {}],
      ['label', { input: doc }, {}],
      ['plan', { input: doc }, {}],
      ['plan', { input: doc }, { changed: { 'src/a.mjs': '3-5', 'tests/b.test.mjs': '' } }],
      ['check', { input: doc }, { tests: unitIds.slice(0, 2) }],
      ['check', { base: other, head: doc }, { tests: unitIds }],
      ['guard', { base: other, head: doc }, { approvals: [{ action: 'remove', id: 'u1', by: 'me' }] }],
      ['guard', { base: doc, head: doc }, {}],
    ]) {
      const r = go(cmd, inputs, config, args);
      exits.add(r.exit);
      if (cmd === 'guard' && inputs.base === doc && r.exit !== 2) {
        // Comparing an input with itself can only fail on failing tests at head.
        const failing = r.report.guard.checks.filter((c) => !c.pass).map((c) => c.id);
        assert.deepEqual(failing, doc.tests.some((x) => x.status === 'failed') ? ['head-passes'] : [], `seed ${seed}`);
      }
      if (cmd === 'report' && r.exit === 0) {
        const s = r.report.suite;
        assert.equal(Object.values(s.advice).reduce((a, b) => a + b, 0), s.units, `seed ${seed}: one advice per unit`);
        for (const u of r.report.units) seen.add(u.advice);
        for (const u of r.report.units) if (u.advice === 'retire') assert.equal(u.protected, false, `seed ${seed}: protected never retired`);
        const retired = new Set(r.report.units.filter((u) => u.advice === 'retire').map((u) => u.id));
        if (retired.size) {
          // Joint safety: deleting every retired unit never fails guard's coverage checks.
          const g = go('guard', { base: doc, head: without(doc, retired) }, config, {});
          for (const id of ['coverage-lines', 'coverage-ratio', 'critical-coverage', 'critical-removed']) {
            assert.equal(g.report.guard.checks.find((c) => c.id === id).pass, true, `seed ${seed}: ${id} after retiring`);
          }
          retiredSeen++;
        }
      }
    }
  }
  assert.ok(exits.has(0) && exits.has(1), 'the sweep reaches both passing and failing outcomes');
  assert.ok(retiredSeen > 0, 'the sweep retires something');
  for (const a of ['keep', 'consolidate', 'rewrite', 'move-to-check', 'retire', 'none']) assert.ok(seen.has(a), `the sweep reaches ${a}`);
});

test('every command is accepted and schemas are required', () => {
  assert.deepEqual(COMMANDS, ['report', 'plan', 'check', 'guard', 'label', 'validate']);
  assert.throws(() => run('report', { input: sample() }, {}, {}, {}), /schemas/);
});
