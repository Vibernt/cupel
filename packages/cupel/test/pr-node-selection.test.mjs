import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileMutationFiles } from '../src/pr/profiles/node/selection.mjs';

const input = { tests: [
  { id: 'tests/a.test.cjs::a', file: 'tests/a.test.cjs', status: 'passed' },
  { id: 'tests/b.test.cjs::b', file: 'tests/b.test.cjs', status: 'passed' },
  { id: 'tests/c.test.cjs::c', file: 'tests/c.test.cjs', status: 'failed' },
], coverage: { granularity: 'test',
  byTest: { 'tests/a.test.cjs::a': { 'src/auth.cjs': '1-2' },
    'tests/b.test.cjs::b': {}, 'tests/c.test.cjs::c': { 'src/auth.cjs': '1' } },
  setup: { 'tests/b.test.cjs': { 'src/auth.cjs': '2' } }, unstable: {} } };

test('profile mutant selection uses passed per-test and setup owners', () => {
  assert.deepEqual(profileMutationFiles(input, 'src/auth.cjs', 1), ['tests/a.test.cjs']);
  assert.deepEqual(profileMutationFiles(input, 'src/auth.cjs', 2),
    ['tests/a.test.cjs', 'tests/b.test.cjs']);
});

test('profile mutant selection refuses unstable or malformed coverage', () => {
  assert.throws(() => profileMutationFiles({ ...input,
    coverage: { ...input.coverage, unstable: { 'src/auth.cjs': '2' } } },
  'src/auth.cjs', 2), /unstable coverage/);
  assert.throws(() => profileMutationFiles({ ...input,
    coverage: { ...input.coverage, byTest: {
      ...input.coverage.byTest, 'tests/a.test.cjs::a': { 'src/auth.cjs': 'garbage' } } } },
  'src/auth.cjs', 1), /line set is malformed/);
});
