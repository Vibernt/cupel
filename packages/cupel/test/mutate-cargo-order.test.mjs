import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTargets } from '../src/mutate-cargo/order.mjs';

// Target keys as fast.mjs builds them (file path with a NUL between parts), plus simple ones.
const A = 'pkg\0tests/a.rs';
const B = 'pkg\0tests/b.rs';
const C = 'pkg\0tests/c.rs';
const D = 'other\0tests/d.rs';

const names = new Map([
  [A, new Set(['t1'])],
  [B, new Set(['t2', 't3', 't4'])],
  [C, new Set(['t5', 't6'])],
  [D, new Set(['t7', 't8'])],
]);
const ms = new Map([[A, 50], [B, 900], [C, 10], [D, 10]]);
const inputMs = (key) => ms.get(key) ?? 0;
const keyOfTest = (id) => ({ t1: A, t2: B, t3: B, t5: C, t7: D })[id];

test('no history orders by covering tests desc, input ms asc, then key', () => {
  // B has the most tests; C and D tie on tests and ms, so the key decides (other sorts before pkg, so D before C).
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs }), [B, D, C, A]);
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, previousCatchers: [] }), [B, D, C, A]);
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, keyOfTest }), [B, D, C, A]);
});

test('input ms breaks ties before the key', () => {
  const quick = new Map([[A, 1], [B, 5]]);
  const sameNames = new Map([[A, new Set(['x'])], [B, new Set(['y'])]]);
  assert.deepEqual(orderTargets({ keys: [B, A], namesByKey: sameNames, inputMs: (k) => quick.get(k) }), [A, B]);
});

test('history moves the catchers targets first, in catcher order', () => {
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, previousCatchers: ['t7', 't1'], keyOfTest }), [D, A, B, C]);
});

test('a catcher in a target that already leads changes nothing else', () => {
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, previousCatchers: ['t2'], keyOfTest }), [B, D, C, A]);
});

test('unknown or absent catcher keys are ignored', () => {
  // t9 has no key, t5 maps to C which is not in keys, and a key outside keys is never added.
  const keys = [A, B, D];
  assert.deepEqual(orderTargets({ keys, namesByKey: names, inputMs, previousCatchers: ['t9', 't1'], keyOfTest: (id) => ({ t1: A, t5: C })[id] }), [A, B, D]);
  assert.deepEqual(orderTargets({ keys, namesByKey: names, inputMs, previousCatchers: ['t9'], keyOfTest: () => undefined }), [B, D, A]);
  assert.deepEqual(orderTargets({ keys, namesByKey: names, inputMs, previousCatchers: ['t1'] }), [B, D, A]);
});

test('duplicate catchers and duplicate keys are removed', () => {
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, previousCatchers: ['t1', 't7', 't1', 't7'], keyOfTest }), [A, D, B, C]);
  assert.deepEqual(orderTargets({ keys: [A, B, A], namesByKey: names, inputMs, previousCatchers: ['t1', 't2'], keyOfTest }), [A, B]);
});

test('output is a permutation of the input keys, with and without history', () => {
  const keys = [D, C, B, A];
  for (const previousCatchers of [[], ['t1'], ['t2', 't5', 't7'], ['zz', 't3', 't3']]) {
    const out = orderTargets({ keys, namesByKey: names, inputMs, previousCatchers, keyOfTest });
    assert.equal(out.length, keys.length);
    assert.deepEqual([...out].sort(), [...keys].sort());
  }
});

test('deterministic: the same inputs give the same order', () => {
  const args = { keys: [D, C, B, A], namesByKey: names, inputMs, previousCatchers: ['t5', 't1'], keyOfTest };
  assert.deepEqual(orderTargets(args), orderTargets(args));
});

test('empty keys give an empty order', () => {
  assert.deepEqual(orderTargets({ keys: [], namesByKey: new Map(), inputMs: () => 0, previousCatchers: ['t1'], keyOfTest }), []);
});

test('targets with a test from the fault\'s own file come after previous catchers and before the rest', () => {
  // Without near keys: B, D, C, A. A near key moves A ahead of the rest; a previous catcher still goes first.
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, nearKeys: [A] }), [A, B, D, C]);
  // Several near targets keep the input rule among themselves (C has more covering tests than A), whatever their order given.
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, nearKeys: [A, C] }), [C, A, B, D]);
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, nearKeys: [C, A] }), [C, A, B, D]);
  assert.deepEqual(orderTargets({ keys: [A, B, C, D], namesByKey: names, inputMs, nearKeys: [A, 'missing'], previousCatchers: ['t-d'], keyOfTest: (id) => (id === 't-d' ? D : undefined) }), [D, A, B, C]);
});
