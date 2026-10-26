import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amortized, median, pairOrder } from './schedule.mjs';

test('five pairs alternate both compared whole calls', () => {
  assert.deepEqual(Array.from({length:5}, (_, i) => pairOrder(i, 's16', 's18')),
    [['s16','s18'], ['s18','s16'], ['s16','s18'], ['s18','s16'], ['s16','s18']]);
  assert.throws(() => pairOrder(0, 's18', 's18'), /invalid/);
});

test('amortization keeps the same setup in N=1/10/100', () => {
  assert.deepEqual(amortized(100, 20), { 1:120, 10:30, 100:21 });
  assert.equal(median([5,1,4,3,2]), 3);
  assert.throws(() => amortized(-1, 20), /invalid/);
});
