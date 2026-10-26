import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threeWayOrder } from './schedule.mjs';

test('five triplets alternate old/guard and guard/current relative order', () => {
  const orders = Array.from({ length:5 }, (_, i) => threeWayOrder(i));
  assert.deepEqual(orders[0], ['old','guards','current']);
  assert.deepEqual(orders[1], ['current','guards','old']);
  for (const order of orders) assert.deepEqual([...order].sort(), ['current','guards','old']);
  assert.throws(() => threeWayOrder(-1), /invalid pair index/);
});
