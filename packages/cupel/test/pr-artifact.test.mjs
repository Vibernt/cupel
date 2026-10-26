import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealNodeProfileBaseline, loadPinnedNodeProfileBaseline } from '../src/pr/artifact.mjs';
import { nodeProfileProducerProof } from '../src/pr/producer.mjs';
import { nodeProfileRuntimeIdentity } from '../src/pr/runtime.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const commit = 'a'.repeat(40);

function artifact() {
  const producer = nodeProfileProducerProof();
  const file = 'tests/a.test.cjs', source = 'src/auth.cjs', id = 'mutant:1';
  const parityRows = [{ id: `${file}::a`, file, name: 'a', status: 'passed', tags: [] }];
  const inputManifest = { [source]: sha('source'), [file]: sha('test') };
  return { version: 'cupel-pr-baseline/1', profile: 'node-readonly-files-v2',
    baseCommit: commit, privacyPolicy: 'strict-v1', producer,
    runtime: nodeProfileRuntimeIdentity('/opt/homebrew/Cellar/node/26.7.0/bin/node'),
    git: { commit, inputManifest, opaqueRootNpmrc: 'absent', opaqueGit: null }, config: {},
    collection: { mode: 'full', inputPolicy: 'strict-v1', fullFiles: [file],
      runRows: [parityRows, parityRows],
      observations: { [file]: { imports: [source], reads: [], probes: [],
        directories: [], writes: [], filesystemEvents: [] } },
      identity: { inputManifestHash: sha(JSON.stringify(inputManifest)),
        producerHash: producer.producerHash, dependencyLockHash: null },
      input: { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '26.7.0' },
        sources: { [source]: { hash: inputManifest[source], coverable: '1' } },
        tests: [{ id: `${file}::a`, file, name: 'a', status: 'passed' }],
        coverage: { granularity: 'test', byTest: { [`${file}::a`]: { [source]: '1' } }, setup: {} } } },
    reference: { kind: 'complete', mode: 'readonly-normal-runner-reference-v1',
      inputPolicy: 'strict-v1',
      fullFiles: [file], runRows: [parityRows, parityRows],
      identity: { producerHash: producer.producerHash,
        inputManifestHash: sha(JSON.stringify(inputManifest)),
        dependencyLockHash: null, runtimeVersion: '26.7.0', policyHash: sha('policy') },
      processProofs: [0, 1].map(run => ({ run, complete: true,
        expectedFiles: [file], seenFiles: [file], denials: [],
        parentPid: 100 + run, childPids: [200 + run] })) },
    critical: { scope: 'full-critical-sources', sites: [{ id, source, line: 1, operator: 'arith' }],
      mutation: { kind: 'complete', scope: 'explicit-mutant-batch', complete: true,
        mutants: [{ id, source, line: 1, operator: 'arith', status: 'killed' }] } } };
}

test('sealed baseline requires exact external artifact and producer pins', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'pr-artifact-'));
  try {
    const value = artifact(), path = join(dir, 'baseline.json');
    const pins = { expectedProducerHash: value.producer.producerHash, baseCommit: commit };
    const sealed = sealNodeProfileBaseline(path, value, pins);
    assert.deepEqual(loadPinnedNodeProfileBaseline(path,
      { ...pins, expectedBaselineHash: sealed.sha256 }), value);
    assert.throws(() => sealNodeProfileBaseline(path, value, pins), /EEXIST/);
    assert.throws(() => loadPinnedNodeProfileBaseline(path,
      { ...pins, expectedBaselineHash: `sha256:${'0'.repeat(64)}` }), /trusted pin/);
    writeFileSync(path, '{}\n');
    assert.throws(() => loadPinnedNodeProfileBaseline(path,
      { ...pins, expectedBaselineHash: sealed.sha256 }), /trusted pin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('opaque baseline descriptor requires the explicit policy and tracked metadata', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'pr-artifact-'));
  try {
    const value = artifact(), pins = {
      expectedProducerHash: value.producer.producerHash, baseCommit: commit };
    value.git.opaqueRootNpmrc = 'regular';
    value.git.opaqueGit = { path: '.npmrc', mode: '100644', oid: 'b'.repeat(40) };
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'strict.json'), value, pins),
      /opaque root descriptor/);
    value.privacyPolicy = 'express-root-npmrc-opaque-v1';
    value.collection.inputPolicy = value.privacyPolicy;
    value.reference.inputPolicy = value.privacyPolicy;
    assert.doesNotThrow(() => sealNodeProfileBaseline(join(dir, 'opaque.json'), value, pins));
    value.git.opaqueGit.oid = 'bad';
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'bad-oid.json'), value, pins),
      /opaque root descriptor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('baseline seal refuses incomplete critical mutation evidence', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'pr-artifact-'));
  try {
    const value = artifact();
    value.critical.mutation.mutants[0].status = 'error';
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'baseline.json'), value,
      { expectedProducerHash: value.producer.producerHash, baseCommit: commit }),
    /critical mutation incomplete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('baseline seal refuses a forged Node executable digest', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'pr-artifact-'));
  try {
    const value = artifact();
    value.runtime.sha256 = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'baseline.json'), value,
      { expectedProducerHash: value.producer.producerHash, baseCommit: commit }),
    /identity, privacy or producer differs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('baseline seal refuses missing or mismatched readonly reference proof', () => {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'pr-artifact-'));
  try {
    const value = artifact(), pins = {
      expectedProducerHash: value.producer.producerHash, baseCommit: commit };
    delete value.reference;
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'missing.json'), value, pins),
      /readonly reference parity/);
    const mismatched = artifact();
    mismatched.reference.runRows[0] = [{ ...mismatched.reference.runRows[0][0], status: 'failed' }];
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'mismatch.json'), mismatched, pins),
      /readonly reference parity/);
    const truncated = artifact();
    truncated.reference.processProofs[1].complete = false;
    assert.throws(() => sealNodeProfileBaseline(join(dir, 'truncated.json'), truncated, pins),
      /process proof incomplete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
