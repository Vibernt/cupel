import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationParity, median } from './parity.mjs';

const example = () => ({ mutation: { mutants: [{ id: 'm', status: 'killed' }] },
  confirmed: { mutants: [{ id: 'm', status: 'killed' }] }, counts: { tests: 3, mutants: 1, survivorRechecks: 0 },
  metrics: { generated: 1, sites: 1, textBuilds: 1, valid: 1, invalid: 0, run: 1 } });

test('exact outputs and legacy run counts must match while new diagnostic fields may differ', () => {
  const old = example(), current = example();
  current.metrics.factHits = 1;
  assert.doesNotThrow(() => assertMutationParity(old, current, 'case'));
  current.metrics.run = 0;
  assert.throws(() => assertMutationParity(old, current, 'case'), /run changed/);
  current.metrics.run = 1;
  current.confirmed.mutants[0].status = 'survived';
  assert.throws(() => assertMutationParity(old, current, 'case'), /confirmation output changed/);
});

test('median rejects absent and nonfinite timing samples', () => {
  assert.equal(median([5, 1, 3, 2, 4]), 3);
  assert.throws(() => median([]), /finite samples/);
  assert.throws(() => median([1, Infinity]), /finite samples/);
});
