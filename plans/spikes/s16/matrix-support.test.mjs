import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDecision, compareSelected, outcome, summarize } from './matrix-support.mjs';

const a = { file: 'a.test.mjs', id: 'a#1', status: 'failed' };
const b = { file: 'b.test.mjs', id: 'b#1', status: 'passed' };

test('matrix decision comparison binds old, candidate and saved file identity', () => {
  const expected = { expectedDecision: 'selected', decision: 'selected',
    selectedFiles: ['a.test.mjs'] };
  const old = { kind: 'selected', files: ['a.test.mjs'] };
  assert.equal(compareDecision('fault', expected, old, old), 'selected');
  assert.throws(() => compareDecision('fault', expected, old,
    { kind: 'selected', files: ['b.test.mjs'] }), /selected files differ/);
  assert.throws(() => compareDecision('fault', expected, old,
    { kind: 'full', files: ['a.test.mjs'] }), /S16 decision/);
  assert.throws(() => compareDecision('fault', { ...expected,
    selectedFiles: ['b.test.mjs'] }, old, old), /saved S12b/);
});

test('matrix row comparison rejects missed, changed and extra results', () => {
  assert.equal(outcome([a, b]), 'fail');
  assert.deepEqual(compareSelected('fault', [a, b], [a], [a], ['a.test.mjs']),
    { fullRows: 2, selectedRows: 1, fullFailures: 1 });
  assert.throws(() => compareSelected('fault', [a, b], [b], [b],
    ['b.test.mjs']), /misses a full fault/);
  assert.throws(() => compareSelected('fault', [a, b], [a],
    [{ ...a, status: 'passed' }], ['a.test.mjs']), /differ/);
  assert.throws(() => compareSelected('fault', [a, b], [a], [a, b],
    ['a.test.mjs']), /differ/);
  assert.throws(() => outcome([a, a]), /duplicate/);
});

test('matrix summary requires all original categories and source pin', () => {
  const names = ['clean', 'ordinary-source', 'new-branch', 'shared-setup',
    'new-test', 'changed-parameter', 'critical-removed', 'source-removed',
    'source-renamed', 'line-shift', 'config-input', 'unknown-source',
    'stale-baseline', 'corrupt-baseline', 'source-text-pin'];
  const refuses = new Set(['critical-removed', 'source-removed',
    'source-renamed', 'unknown-source', 'stale-baseline', 'corrupt-baseline']);
  const passes = new Set(['clean', 'critical-removed', 'unknown-source',
    'stale-baseline', 'corrupt-baseline']);
  const rows = names.map(name => ({ case: name,
    decision: refuses.has(name) ? 'refuse' : name === 'config-input' ? 'full' : 'selected',
    oracle: passes.has(name) ? 'pass' : 'fail',
    selected: passes.has(name) ? 'pass' : 'fail',
    selectedFiles: name === 'source-text-pin' ? Array(4).fill('file') : [],
    fullFiles: Array(8).fill('file'),
    strictSubset: !refuses.has(name) && name !== 'config-input' }));
  const summary = summarize(rows);
  assert.equal(summary.changedStrictSubsets, 7);
  assert.throws(() => summarize(rows.slice(1)), /15 cases/);
  assert.throws(() => summarize(rows.map(row => row.case === 'ordinary-source' ?
    { ...row, selected: 'pass' } : row)), /not caught/);
});
