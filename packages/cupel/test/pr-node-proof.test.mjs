import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCoverageProof } from '../src/pr/profiles/node/coverage-proof.mjs';

const row = { file: 'tests/a.test.cjs', id: 'a#1', fullName: 'a', ordinal: 1,
  status: 'passed' };
const complete = () => ({ version: 'cupel-node-coverage/1', owner: row.file,
  inputManifestHash: 'sha256:' + 'a'.repeat(64), errors: [],
  boundaries: { before: 1, beforeEach: 1, afterEach: 1, after: 1, exit: 1, checkpoints: 5 },
  setup: { 'src/a.cjs': [0, 4] },
  tests: [{ fullName: 'a', ordinal: 0, completed: true, cov: { 'src/a.cjs': [4, 9] } }] });
const options = { file: row.file, inputManifestHash: 'sha256:' + 'a'.repeat(64),
  rows: [row], sources: new Set(['src/a.cjs']) };

test('valid Node coverage proof binds source, owner and reporter row', () => {
  assert.deepEqual(verifyCoverageProof(complete(), options),
    { byTest: { 'a#1': { 'src/a.cjs': [4, 9] } }, setup: { 'src/a.cjs': [0, 4] } });
});

test('missing, forged, truncated and error-bearing coverage proofs refuse', () => {
  for (const change of [
    value => { value.owner = 'tests/foreign.test.cjs'; },
    value => { value.inputManifestHash = 'sha256:' + 'b'.repeat(64); },
    value => { value.errors.push('take failed'); },
    value => { value.boundaries.exit = 0; },
    value => { value.boundaries.afterEach = 0; },
    value => { value.tests[0].completed = false; },
    value => { value.tests[0].fullName = 'other'; },
    value => { value.tests[0].ordinal = 1; },
    value => { value.tests[0].cov['src/a.cjs'] = [9, 4]; },
    value => { value.tests[0].cov['../secret'] = [0, 4]; },
    value => { value.tests.push(structuredClone(value.tests[0])); },
  ]) {
    const value = complete();
    change(value);
    assert.throws(() => verifyCoverageProof(value, options));
  }
});

test('parent test coverage is conservatively inherited by its leaf', () => {
  const record = complete();
  record.boundaries.beforeEach = 2;
  record.boundaries.afterEach = 2;
  record.boundaries.checkpoints = 7;
  record.tests = [
    { fullName: 'parent', ordinal: 0, completed: true, cov: { 'src/a.cjs': [4, 7] } },
    { fullName: 'parent > child', ordinal: 0, completed: true, cov: { 'src/a.cjs': [8, 12] } },
  ];
  const rows = [{ ...row, id: 'parent > child#1', fullName: 'parent > child' }];
  assert.deepEqual(verifyCoverageProof(record, { ...options, rows }).byTest,
    { 'parent > child#1': { 'src/a.cjs': [4, 7, 8, 12] } });
});
