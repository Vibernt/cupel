import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNodeProfileBaseline } from '../src/pr/prepare.mjs';
import { loadPinnedNodeProfileBaseline } from '../src/pr/artifact.mjs';
import { nodeProfileProducerProof } from '../src/pr/producer.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture({ criticalSkipped = false } = {}) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-prepare-root-'));
  const output = mkdtempSync(join(scratch, 'pr-prepare-output-'));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'src/auth.cjs'), 'module.exports = value => value + 1;\n');
  writeFileSync(join(root, 'tests/a.test.cjs'),
    `const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');test${criticalSkipped ? '.skip' : ''}('a [critical]',()=>assert.equal(auth(2),3));\n`);
  writeFileSync(join(root, 'tests/b.test.cjs'),
    "const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');test('b',()=>assert.equal(auth(4),5));\n");
  const config = { runners: { node: { tests: 'tests/**/*.test.cjs' } } };
  writeFileSync(join(root, 'cupel.json'), `${JSON.stringify(config)}\n`);
  git(root, 'init', '-q'); git(root, 'add', 'src/auth.cjs', 'tests/a.test.cjs', 'tests/b.test.cjs', 'cupel.json');
  git(root, '-c', 'user.name=Cupel Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'fixture', '-m',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  return { root, output, commit: git(root, 'rev-parse', 'HEAD'),
    files: ['tests/a.test.cjs', 'tests/b.test.cjs'],
    config,
    close() { rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true }); } };
}

test('Node 26 prepare seals exact Git, profile, readonly reference and critical mutation', () => {
  const f = fixture();
  try {
    const expectedProducerHash = nodeProfileProducerProof().producerHash;
    const result = prepareNodeProfileBaseline({ root: f.root, baseCommit: f.commit,
      files: f.files, out: join(f.output, 'prepare'),
      artifactPath: join(f.output, 'baseline.json'), config: f.config,
      nodePath, expectedProducerHash });
    assert.equal(result.kind, 'prepared');
    const baseline = loadPinnedNodeProfileBaseline(result.artifact.path,
      { expectedBaselineHash: result.artifact.sha256,
        expectedProducerHash, baseCommit: f.commit });
    assert.equal(baseline.reference.mode, 'readonly-normal-runner-reference-v1');
    assert.equal(baseline.reference.processProofs.length, 2);
    assert.equal(baseline.collection.input.tests.length, 2);
    assert.equal(baseline.critical.sites.length, 1);
    assert.equal(baseline.critical.mutation.mutants[0].status, 'killed');
  } finally { f.close(); }
});

test('baseline preparation refuses a skipped critical test', () => {
  const f = fixture({ criticalSkipped: true });
  try {
    assert.throws(() => prepareNodeProfileBaseline({ root: f.root,
      baseCommit: f.commit, files: f.files, out: join(f.output, 'prepare'),
      artifactPath: join(f.output, 'baseline.json'), config: f.config,
      nodePath, expectedProducerHash: nodeProfileProducerProof().producerHash }),
    /baseline critical test did not pass/);
  } finally { f.close(); }
});
