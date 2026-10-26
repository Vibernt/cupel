import assert from 'node:assert/strict';
import test from 'node:test';
import { alternatingOrder, median, performanceGate } from './schedule.mjs';

test('five pairs alternate order and median ignores acquisition order', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(pair => alternatingOrder(pair, 'old', 'candidate')),
    [['old', 'candidate'], ['candidate', 'old'], ['old', 'candidate'],
      ['candidate', 'old'], ['old', 'candidate']]);
  assert.equal(median([30, 10, 20]), 20);
});

test('optimization and product gates require paired wins and median margin', () => {
  const old = [100, 100, 100, 100, 100].map((value, index) =>
    ({ old: value, candidate: index === 4 ? 101 : 79 }));
  const full = [90, 90, 90, 90, 90].map((value, index) =>
    ({ full: value, candidate: index === 4 ? 91 : 79 }));
  const result = performanceGate(old, full);
  assert.equal(result.optimization, true);
  assert.equal(result.productionUsefulness, true);
  assert.equal(performanceGate(old.map(pair => ({ ...pair, candidate: 81 })), full).optimization, false);
  assert.equal(performanceGate(old, full.map(pair => ({ ...pair, candidate: 81 }))).productionUsefulness, false);
  assert.throws(() => performanceGate(old.slice(1), full), /five paired/);
});
