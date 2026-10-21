// I1-I3: validation and diagnostics, exit 2 (E1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, input, t, report, codes, mutant } from './engine-helpers.mjs';
import { run } from '../src/engine/index.mjs';
import { schemas } from './engine-helpers.mjs';

const ok = () => input({ tests: [t('a')], cov: { a: { 'src/a.mjs': '1-3' } } });

const onlyKeys = (rep) => assert.deepEqual(Object.keys(rep.report), ['spec', 'kind', 'command', 'diagnostics']);

test('a valid input passes I1-I3', () => {
  const r = report(ok());
  assert.equal(r.exit, 0);
  assert.deepEqual(r.report.diagnostics, []);
});

test('I1 invalid input: invalid-input with the JSON path, exit 2, nothing else reported', () => {
  const doc = ok();
  doc.tests[0].status = 'ok';
  const r = go('report', { input: doc }, {}, { generatedAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.exit, 2);
  assert.deepEqual(r.report.diagnostics.map((d) => [d.code, d.path]), [['invalid-input', '/tests/0/status']]);
  onlyKeys(r);
});

test('I1 another spec major is invalid input', () => {
  const r = report({ ...ok(), spec: 'cupel-spec/2' });
  assert.equal(r.exit, 2);
  assert.deepEqual(codes(r), ['invalid-input']);
});

test('I1 a minor spec version is accepted', () => {
  assert.equal(report({ ...ok(), spec: 'cupel-spec/1.4' }).exit, 0);
});

test('I1 invalid config: invalid-config with the JSON path, exit 2', () => {
  const r = report(ok(), { advice: { shapeSimilarity: 2 } });
  assert.equal(r.exit, 2);
  assert.deepEqual(r.report.diagnostics.map((d) => [d.code, d.path]), [['invalid-config', '/advice/shapeSimilarity']]);
});

test('I2 unknown-test in byTest, killedBy and brittleness', () => {
  const doc = input({
    tests: [t('a')],
    cov: { a: { 'src/a.mjs': '1' }, ghost: { 'src/a.mjs': '1' } },
    mutants: [mutant('m1', 1, ['nobody'])],
    brittleness: [{ test: 'phantom', kind: 'css-class' }],
  });
  const r = report(doc);
  assert.equal(r.exit, 2);
  assert.deepEqual(r.report.diagnostics.map((d) => [d.code, d.test]).sort(), [
    ['unknown-test', 'ghost'], ['unknown-test', 'nobody'], ['unknown-test', 'phantom'],
  ]);
});

test('I2 unknown-unit in rechecked, targeted and shapes; rows are fine as unit ids only when they are units', () => {
  const doc = input({
    tests: [t('a#1', { unit: 'a' }), t('a#2', { unit: 'a' })],
    cov: {},
    rechecked: ['a#1'],
    mutants: [],
    targeted: ['b'],
    shapes: { a: [1], c: [2] },
  });
  const r = report(doc);
  assert.equal(r.exit, 2);
  assert.deepEqual(r.report.diagnostics.map((d) => d.test).sort(), ['a#1', 'b', 'c']);
  assert.ok(codes(r).every((c) => c === 'unknown-unit'));
});

test('I2 unit-spans-files and duplicate-test', () => {
  const doc = input({ tests: [t('x', { unit: 'u' }), t('y', { unit: 'u', file: 'tests/b.test.mjs' }), t('z'), t('z')] });
  const r = report(doc);
  assert.equal(r.exit, 2);
  assert.deepEqual(codes(r).sort(), ['duplicate-test', 'unit-spans-files']);
});

test('I2 argument tests must name a unit or a test id', () => {
  const doc = input({ tests: [t('a#1', { unit: 'a' })] });
  assert.equal(go('check', { input: doc }, {}, { tests: ['a'] }).exit !== 2, true);
  assert.equal(go('check', { input: doc }, {}, { tests: ['a#1'] }).exit !== 2, true);
  const r = go('check', { input: doc }, {}, { tests: ['nope'] });
  assert.equal(r.exit, 2);
  assert.deepEqual(codes(r), ['unknown-test']);
});

test('I3 line-not-coverable, unknown-source and bad-range in coverage', () => {
  const doc = input({
    sources: { 'src/a.mjs': { coverable: '1-10' } },
    tests: [t('a'), t('b'), t('c')],
    cov: { a: { 'src/a.mjs': '9-11' }, b: { 'src/zzz.mjs': '1' }, c: { 'src/a.mjs': '5-3' } },
  });
  const r = report(doc);
  assert.equal(r.exit, 2);
  assert.deepEqual(r.report.diagnostics.map((d) => [d.code, d.path]), [
    ['bad-range', '/coverage/byTest/c/src~1a.mjs'],
    ['line-not-coverable', '/coverage/byTest/a/src~1a.mjs'],
    ['unknown-source', '/coverage/byTest/b/src~1zzz.mjs'],
  ]);
});

test('I3 setup, byFile and mutants are checked too', () => {
  const doc = input({
    sources: { 'src/a.mjs': { coverable: '1-10' } },
    tests: [t('a')],
    granularity: 'file',
    byFile: { 'tests/a.test.mjs': { 'src/a.mjs': '12' } },
    setup: { 'tests/a.test.mjs': { 'src/b.mjs': '1' } },
    mutants: [mutant('m1', 11, ['a']), mutant('m2', 1, ['a'], 'killed', 'src/q.mjs')],
  });
  const r = report(doc);
  assert.equal(r.exit, 2);
  assert.deepEqual(r.report.diagnostics.map((d) => [d.code, d.path]), [
    ['line-not-coverable', '/coverage/byFile/tests~1a.test.mjs/src~1a.mjs'],
    ['line-not-coverable', '/mutation/mutants/0/line'],
    ['unknown-source', '/coverage/setup/tests~1a.test.mjs/src~1b.mjs'],
    ['unknown-source', '/mutation/mutants/1/source'],
  ]);
});

test('I3 bad-range in a source coverable set', () => {
  const r = report(input({ sources: { 's.mjs': { coverable: '4-2' } }, tests: [t('a')] }));
  assert.equal(r.exit, 2);
  assert.deepEqual(codes(r), ['bad-range']);
});

test('guard validates both inputs and labels which one failed', () => {
  const head = ok();
  head.tests[0].file = 7;
  const r = go('guard', { base: ok(), head });
  assert.equal(r.exit, 2);
  assert.equal(r.report.diagnostics[0].code, 'invalid-input');
  assert.match(r.report.diagnostics[0].message, /^head: /);
});

test('missing inputs and arguments exit 2', () => {
  assert.deepEqual(codes(go('guard', { base: ok() })), ['missing-input']);
  assert.deepEqual(codes(go('check', { input: ok() }, {}, {})), ['missing-argument']);
  assert.deepEqual(codes(go('guard', { base: ok(), head: ok() }, {}, { approvals: [{ action: 'remove', id: 'a' }] })), ['invalid-arguments']);
  assert.deepEqual(codes(go('plan', { input: ok() }, {}, { changed: { 'src/a.mjs': '3-1' } })), ['bad-range']);
});

test('an unknown command is a caller error', () => {
  assert.throws(() => run('frobnicate', { input: ok() }, {}, {}, schemas), /unknown command/);
});

test('diagnostics are sorted by code, then path', () => {
  const doc = input({ tests: [t('b'), t('a')], cov: { zz: {}, aa: {} } });
  const r = report(doc);
  assert.deepEqual(r.report.diagnostics.map((d) => d.path), ['/coverage/byTest/aa', '/coverage/byTest/zz']);
});
