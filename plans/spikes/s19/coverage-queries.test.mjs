import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageQueries, ranges } from './coverage-queries.mjs';

test('replay samples each distinct covered coverable query once', () => {
  const input = { sources: { 'b.mjs': { coverable: '1-3' },
    'a.mjs': { coverable: '1-5' } },
  coverage: { byTest: { one: { 'a.mjs': '1-3', 'b.mjs': '2' } },
    setup: { file: { 'a.mjs': '2-4' } }, byFile: { file: { 'b.mjs': '3' } } } };
  const result = coverageQueries(input, 4);
  assert.equal(result.totalAvailableUnique, 8);
  assert.equal(result.coveredAvailableUnique, 6);
  assert.deepEqual(result.queries, [
    { source: 'a.mjs', line: 1 }, { source: 'b.mjs', line: 2 },
    { source: 'a.mjs', line: 2 }, { source: 'b.mjs', line: 3 },
  ]);
  assert.deepEqual(coverageQueries(input, 20).queries.length, 6);
});

test('malformed or overlapping saved ranges refuse', () => {
  assert.throws(() => ranges('1-3,3-5'), /overlap/);
  assert.throws(() => ranges('5-3'));
  assert.throws(() => coverageQueries({ sources: { 'x.mjs': { coverable: '1' } },
    coverage: { byTest: {} } }), /no covered coverable query/);
});
