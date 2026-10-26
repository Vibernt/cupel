import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRowsEqual, FILES, median, pairOrder, resultRows } from './recheck-utils.mjs';

test('result parser preserves exact file, duplicate ordinal and failure', () => {
  const root = '/public/express';
  const file = FILES[0];
  const event = (type, name) => JSON.stringify({ type, data: { file: `${root}/${file}`, name, details: {} } });
  const output = [event('test:pass', 'same'), event('test:fail', 'same'),
    JSON.stringify({ type: 'test:plan', data: {} })].join('\n');
  assert.deepEqual(resultRows(output, root), [
    { file, id: 'same#1', status: 'passed' },
    { file, id: 'same#2', status: 'failed' },
  ]);
  assert.throws(() => resultRows(event('test:pass', 'same'), root), /incomplete/);
});

test('exact rows reject a changed status and median is order independent', () => {
  const good = [{ file: FILES[0], id: 'case#1', status: 'failed' }];
  assertRowsEqual(good, [...good], 'control');
  assert.throws(() => assertRowsEqual(good, [{ ...good[0], status: 'passed' }], 'fault'), /differ/);
  assert.equal(median([8, 2, 4]), 4);
});

test('five pairs alternate their first method', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(pairOrder), [
    ['full', 'selected'], ['selected', 'full'], ['full', 'selected'],
    ['selected', 'full'], ['full', 'selected'],
  ]);
});
