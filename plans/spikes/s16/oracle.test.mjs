import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFullCapture, assertSameRows, assertSelectedCatches, exactRows, reporterRows } from './oracle.mjs';

const full = [
  { file: 'a.test.mjs', id: 'a#1', status: 'failed' },
  { file: 'b.test.mjs', id: 'b#1', status: 'passed' },
];

test('selected evidence catches exact full failure and confirms strict subset', () => {
  assert.deepEqual(assertSelectedCatches(full, [full[0]], ['a.test.mjs'],
    ['a.test.mjs', 'b.test.mjs'], 1),
  { fullTests: 2, selectedTests: 1, fullFailures: 1, selectedFiles: 1, strictSubset: true });
});

test('oracle refuses missed failure, false green, missing row and duplicate ID', () => {
  assert.throws(() => assertSelectedCatches(full, [full[1]], ['b.test.mjs'],
    ['a.test.mjs', 'b.test.mjs'], 1), /miss/);
  assert.throws(() => assertSelectedCatches(full, [{ ...full[0], status: 'passed' }], ['a.test.mjs'],
    ['a.test.mjs', 'b.test.mjs'], 1), /differ/);
  assert.throws(() => assertSelectedCatches(full, [], ['a.test.mjs'],
    ['a.test.mjs', 'b.test.mjs'], 1), /missing test rows/);
  assert.throws(() => exactRows([full[0], full[0]], 'duplicate'), /duplicate/);
  assert.throws(() => assertSameRows(full, [{ ...full[0], status: 'passed' }, full[1]], 'parity'), /differ/);
});

test('reporter parser requires plan and exact file identity', () => {
  const root = '/fixture';
  const result = JSON.stringify({ type: 'test:fail', data: { file: `${root}/a.test.mjs`,
    name: 'a', details: {} } });
  const plan = JSON.stringify({ type: 'test:plan', data: {} });
  assert.deepEqual(reporterRows(`${result}\n${plan}\n`, root, ['a.test.mjs']),
    [{ file: 'a.test.mjs', id: 'a#1', status: 'failed' }]);
  assert.throws(() => reporterRows(result, root, ['a.test.mjs']), /incomplete/);
  assert.throws(() => reporterRows(`${result}\n${plan}`, '/other', ['a.test.mjs']), /foreign/);
});

test('full capture refuses missing privacy guard before score interpretation', () => {
  assert.throws(() => assertFullCapture({ ordinaryFull: { privacyGuarded: false } },
    ['a.test.mjs'], 1, 'fault'), /privacy\/parity/);
});
