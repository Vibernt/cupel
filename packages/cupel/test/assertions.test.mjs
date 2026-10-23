import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../src/collect/assertions/value.mjs';
import { analyseAssertions, assertionKey, inputIdentity } from '../src/analysis/assertions.mjs';
import { recorder, bucket } from '../src/collect/assertions/recorder.mjs';

test('canonical values distinguish types, boundaries, cycles, regex and long strings without getters', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.notEqual(fingerprint(0), fingerprint(-0));
  assert.notEqual(fingerprint(undefined), fingerprint(null));
  assert.notEqual(fingerprint(1), fingerprint('1'));
  assert.notEqual(fingerprint(/a/i), fingerprint(/a/g));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
  assert.notEqual(fingerprint(new Set([1])), fingerprint(new Map([[1, 1]])));
  assert.notEqual(fingerprint(new Date(0)), fingerprint(new Date(1)));
  assert.equal(fingerprint(() => 1), fingerprint(() => 2));
  assert.match(fingerprint('x'.repeat(257)), /string-sha256.*,257/);
  assert.notEqual(fingerprint('\ud800'.repeat(257)), fingerprint('\ud801'.repeat(257)));
  const date = new Date(0); Object.defineProperty(date, 'getTime', { get() { throw new Error('must not invoke'); } });
  assert.equal(fingerprint(date), fingerprint(new Date(0)));
  const x = {}; x.self = x;
  assert.equal(fingerprint(x), fingerprint(x));
  assert.doesNotThrow(() => fingerprint({ get value() { throw new Error('must not invoke'); } }));
});
const rec = (value, subject = 'result', matcher = 'strictEqual') => ({ matcher, subject, expectedFingerprint: fingerprint(value), actualFingerprint: fingerprint(value), trivial: false, site: null });
function fixture() {
  const tests = ['a', 'b', 'boundary', 'empty', 'trivial', 'different-shape'].map((id) => ({ id, status: 'passed' }));
  const input = { tests, shapes: Object.fromEntries(tests.map((t) => [t.id, t.id === 'different-shape' ? ['z'] : ['a', 'b']])) };
  const data = { a: [rec(1)], b: [rec(1), rec(1)], boundary: [rec(2)], empty: [], trivial: [{ ...rec(true), trivial: true }], 'different-shape': [rec(1)] };
  const sidecar = { version: 'cupel-assertions/1', inputIdentity: inputIdentity(input), tests: Object.fromEntries(Object.entries(data).map(([id, records]) => [id, { ...bucket(), count: records.length, records }])) };
  return { input, sidecar };
}
test('sets, units, expected boundaries, shape threshold, triviality and deterministic ordering', () => {
  const { input, sidecar } = fixture();
  const report = analyseAssertions(input, sidecar);
  const by = Object.fromEntries(report.units.map((u) => [u.id, u]));
  assert.deepEqual(by.a.subsumedBy, ['b', 'different-shape']);
  assert.deepEqual(by.a.cloneOf, ['b']);
  assert.deepEqual(by.boundary.subsumedBy, []);
  assert.equal(by.boundary.uniqueFingerprints.length, 1);
  assert.equal(by.empty.assertionFree, true);
  assert.deepEqual(by.empty.subsumedBy, []);
  assert.equal(by.trivial.assertionFree, true);
  assert.notEqual(assertionKey(rec(1, 'left')), assertionKey(rec(1, 'right')));
  const before = JSON.stringify({ input, sidecar });
  assert.deepEqual(analyseAssertions({ ...input, tests: [...input.tests].reverse() }, sidecar), report);
  assert.equal(JSON.stringify({ input, sidecar }), before);
  assert.throws(() => analyseAssertions({ ...input, tests: [] }, sidecar), /does not match/);
  sidecar.tests.a.capHit = true;
  const capped = analyseAssertions(input, sidecar).units[0];
  assert.deepEqual(capped.subsumedBy, []);
  assert.equal(capped.assertionFree, null);
});
test('recording cap counts all attempts, ambiguity and serialization errors are explicit', () => {
  const a = bucket();
  const record = recorder('/unmatched', () => [a], 2);
  for (let i = 0; i < 4; i++) record('ok', true, undefined);
  assert.equal(a.count, 4); assert.equal(a.records.length, 2); assert.equal(a.capHit, true);
  const b = bucket();
  recorder('/unmatched', () => [b])('equal', new Proxy({}, { ownKeys() { throw new Error('blocked'); } }), 1);
  assert.equal(b.incomplete, true); assert.match(b.errors[0], /blocked/);
  recorder('/unmatched', () => [a, b])('ok', true, undefined);
  assert.equal(a.incomplete, true); assert.equal(b.incomplete, true);
  assert.throws(() => recorder('/', () => [], 0), /positive integer/);
});

test('unit rows aggregate, missing recordings stay unknown, K12 threshold is inclusive', () => {
  const input = { tests: [{ id: 'a1', unit: 'a', status: 'passed' }, { id: 'a2', unit: 'a', status: 'passed' }, { id: 'b', status: 'passed' }],
    shapes: { a: ['0', '1', '2', '3', '4', '5', '6', '7', '8'], b: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] } };
  const data = (records) => ({ ...bucket(), count: records.length, records });
  const sidecar = { version: 'cupel-assertions/1', inputIdentity: inputIdentity(input), tests: { a1: data([rec(1)]), a2: data([rec(2)]), b: data([rec(1), rec(2)]) } };
  const report = analyseAssertions(input, sidecar);
  assert.equal(report.units[0].assertionCount, 2); assert.deepEqual(report.units[0].cloneOf, ['b']);
  delete sidecar.tests.a2;
  assert.equal(analyseAssertions(input, sidecar).units[0].assertionFree, null);
  assert.deepEqual(analyseAssertions(input, sidecar).units[1].subsumedBy, []);
});
