import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { add, clamp } from '../src/math.mjs';

let calls = 0;
beforeEach(() => {
  calls++;
});

test('add sums two numbers [critical]', () => {
  assert.equal(add(2, 3), 5);
});

for (const [x, want] of [[-1, 0], [5, 5], [11, 10]]) {
  test(`clamp keeps ${x} in range`, () => {
    assert.equal(clamp(x, 0, 10), want);
  });
}

describe('clamp', () => {
  test('low bound', () => {
    assert.equal(clamp(-5, 0, 10), 0);
  });
});
