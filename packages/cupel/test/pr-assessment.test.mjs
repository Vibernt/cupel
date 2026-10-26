import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessNodeProfileRequest } from '../src/pr/assessment.mjs';

const oldTest = { id: 'tests/auth.test.cjs::auth [critical]',
  file: 'tests/auth.test.cjs', name: 'auth [critical]',
  tags: ['critical'], status: 'passed' };
const site = { id: 'site-1', source: 'src/auth.cjs', line: 1, operator: 'arithmetic' };
const baseline = { git: { inputManifest: { 'src/auth.cjs': 'sha256:old' } },
  collection: { input: { tests: [oldTest], coverage: { byTest: { [oldTest.id]: {} } },
    sources: { 'src/auth.cjs': { hash: 'sha256:old' } } } },
  critical: { mutation: { mutants: [{ ...site, status: 'killed' }] } } };
const decision = { files: [oldTest.file], changed: [oldTest.file],
  changedCriticalTests: [oldTest.file] };
const head = { input: { tests: [oldTest], coverage: { byTest: { [oldTest.id]: {} } },
  sources: { 'src/auth.cjs': { hash: 'sha256:old' } } } };

test('scoped assessment refuses a mutant without executed test coverage', () => {
  assert.throws(() => assessNodeProfileRequest({ baseline, head, decision,
    sites: [site], mutation: { kind: 'complete',
      mutants: [{ ...site, status: 'no-coverage' }] } }), /no executed coverage/);
});

test('edited critical test retains exact identity and tags', () => {
  const altered = { input: { ...head.input,
    tests: [{ ...oldTest, tags: ['standard'] }] } };
  assert.throws(() => assessNodeProfileRequest({ baseline, head: altered, decision,
    sites: [], mutation: null }), /identity or critical tag changed/);
});

test('removed or renamed critical row refuses scoped assessment', () => {
  for (const tests of [[], [{ ...oldTest, id: 'tests/auth.test.cjs::renamed',
    name: 'renamed' }]])
    assert.throws(() => assessNodeProfileRequest({ baseline,
      head: { input: { ...head.input, tests } }, decision,
      sites: [], mutation: null }), /identity or critical tag changed/);
});

test('lost unchanged-source baseline kill remains visible when HEAD site disappears', () => {
  const result = assessNodeProfileRequest({ baseline, head, decision,
    sites: [], mutation: null });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.mutation.lostKills, ['site-1']);
});

test('edited critical test losing unchanged-source branch coverage regresses without a mutant', () => {
  const old = { ...baseline, critical: { mutation: { mutants: [] } }, collection: { input: {
    ...baseline.collection.input,
    sources: { 'src/auth.cjs': { hash: 'sha256:old' } },
    coverage: { byTest: { [oldTest.id]: { 'src/auth.cjs': '1-3' } } },
  } } };
  const current = { input: { ...head.input,
    coverage: { byTest: { [oldTest.id]: { 'src/auth.cjs': '1,3' } } } } };
  const result = assessNodeProfileRequest({ baseline: old, head: current,
    decision, sites: [], mutation: null });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.lostCoverage, [{ test: oldTest.id,
    source: 'src/auth.cjs', lines: '2' }]);
});
