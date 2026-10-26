// Boundary cases for orchestration and advice traversal. These assert public
// reports and exits rather than the engine's private loop structure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, input, t, unit } from './engine-helpers.mjs';

test('guard and validate retain unknown-tag diagnostics without advice output', () => {
  const base = input({ tests: [t('good')], cov: { good: { 'src/a.mjs': '1-3' } } });
  const head = input({ tests: [t('bad', { tags: ['project-specific'] })],
    cov: { bad: { 'src/a.mjs': '1-3' } } });
  const guard = go('guard', { base, head });
  const validate = go('validate', { input: head });
  const label = go('label', { input: head });
  assert.equal(guard.exit, 0);
  assert.equal(validate.exit, 0);
  assert.equal(label.exit, 1);
  assert.deepEqual(guard.report.diagnostics.map(({ code, path, test }) => ({ code, path, test })),
    [{ code: 'unknown-tag', path: '/tests/0/tags/0', test: 'bad' }]);
  assert.deepEqual(validate.report.diagnostics, label.report.diagnostics);
  for (const result of [guard, validate]) {
    assert.equal(result.report.units, undefined);
    assert.equal(result.report.groups, undefined);
    assert.equal(result.report.suite, undefined);
  }
});

test('same-shape groups retain global id order across Unicode files and criticality', () => {
  const rows = [
    t('a', { file: 'tests/école.test.mjs' }), t('b', { file: 'tests/école.test.mjs' }),
    t('c', { file: 'tests/école.test.mjs', tags: ['critical'] }),
    t('d', { file: 'tests/école.test.mjs', tags: ['critical'] }),
    t('e', { file: 'tests/école|true.test.mjs' }), t('f', { file: 'tests/école|true.test.mjs' }),
  ];
  const cov = Object.fromEntries(rows.map(({ id }) => [id, { 'src/a.mjs': '1-4' }]));
  const shapes = Object.fromEntries(rows.map(({ id }) => [id, [1]]));
  const result = go('report', { input: input({ tests: rows, cov, shapes }) });
  assert.deepEqual(result.report.groups, [
    { id: 'g1', kind: 'same-shape', file: 'tests/école.test.mjs', units: ['a', 'b'] },
    { id: 'g2', kind: 'same-shape', file: 'tests/école.test.mjs', units: ['c', 'd'] },
    { id: 'g3', kind: 'same-shape', file: 'tests/école|true.test.mjs', units: ['e', 'f'] },
  ]);
  assert.deepEqual(result.report.units.map(({ group }) => group), ['g1', 'g1', 'g2', 'g2', 'g3', 'g3']);
});

test('file summaries count each file once with multiple rows and setup subtraction', () => {
  const result = go('report', { input: input({ granularity: 'file',
    tests: [t('a'), t('b'), t('c', { file: 'tests/z.test.mjs' })],
    byFile: { 'tests/a.test.mjs': { 'src/a.mjs': '1-3' },
      'tests/z.test.mjs': { 'src/a.mjs': '3-5' } },
    setup: { 'tests/a.test.mjs': { 'src/a.mjs': '1' } },
  }) });
  assert.deepEqual(result.report.files, [
    { file: 'tests/a.test.mjs', uniqueLines: 1, hints: [] },
    { file: 'tests/z.test.mjs', uniqueLines: 2, hints: [] },
  ]);
});

test('duplicate evidence picks first passed unit even on the mutation review path', () => {
  const rows = [t('candidate'), t('z'), t('a'), t('0-failed', { status: 'failed' })];
  const cov = Object.fromEntries(rows.map(({ id }) => [id, { 'src/a.mjs': '1-3' }]));
  const shapes = Object.fromEntries(rows.map(({ id }) => [id, [1]]));
  const doc = input({ tests: rows, cov, shapes, rechecked: ['candidate'],
    mutants: [{ id: 'm', source: 'src/a.mjs', line: 1, operator: 'op', status: 'killed',
      killedBy: ['candidate', 'z'] }], targeted: ['candidate'] });
  const result = go('report', { input: doc }, { advice: { consolidate: false } });
  assert.deepEqual(unit(result, 'candidate').hints, ['no-unique-evidence']);
  assert.equal(unit(result, 'candidate').duplicateOf, 'a');
});
