import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceMutants } from '../src/mutate/sites.mjs';
import { collectNodeProfile } from '../src/pr/profiles/node/collect.mjs';
import { runNodeProfileMutationBatch } from '../src/pr/profiles/node/mutation-batch.mjs';
import { nodeProfileProducerProof } from '../src/pr/producer.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';

function fixture(assertion) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-mutant-root-'));
  const output = mkdtempSync(join(scratch, 'pr-mutant-output-'));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
  const source = 'src/math.cjs', text = 'module.exports = value => value + 1;\n';
  writeFileSync(join(root, source), text);
  writeFileSync(join(root, 'tests/math.test.cjs'),
    `const {test}=require('node:test');\nconst assert=require('node:assert/strict');\nconst math=require('../src/math.cjs');\ntest('math [critical]',()=>${assertion});\n`);
  const mutant = sourceMutants(root, source, text).find(item =>
    item.operator === 'arith' && !item.filtered);
  assert.ok(mutant);
  const config = { runners: { node: { tests: 'tests/**/*.test.cjs' } } };
  return { root, output, source, mutant, config, file: 'tests/math.test.cjs',
    close() { rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true }); } };
}

function collect(f) {
  const expectedProducerHash = nodeProfileProducerProof().producerHash;
  const profile = collectNodeProfile({ root: f.root, files: [f.file],
    out: join(f.output, 'collect'), config: f.config, runs: 2,
    nodePath, expectedProducerHash });
  return { ...profile, expectedProducerHash };
}

function mutate(f, collected, out = 'mutate') {
  return runNodeProfileMutationBatch({ root: f.root, input: collected.input,
    selectedMutants: [{ source: f.source, id: f.mutant.id, line: f.mutant.line }],
    out: join(f.output, out), nodePath,
    expectedProducerHash: collected.expectedProducerHash,
    expectedIdentity: collected.identity, expectedDependencies: collected.dependencies,
    maxSeconds: 30 });
}

test('Node v2 loaded arithmetic mutant is killed by a reported previously passing test', () => {
  const f = fixture('assert.equal(math(2),3)');
  try {
    const result = mutate(f, collect(f));
    assert.equal(result.kind, 'complete');
    assert.equal(result.scope, 'explicit-mutant-batch');
    assert.equal(result.mutants[0].status, 'killed');
    assert.deepEqual(result.mutants[0].killedBy, [`${f.file}::math [critical]`]);
    assert.equal(result.attempts, 2);
  } finally { f.close(); }
});

test('Node v2 survivor receives two fresh profile confirmations', () => {
  const f = fixture("assert.equal(typeof math(2),'number')");
  try {
    const result = mutate(f, collect(f));
    assert.equal(result.kind, 'complete');
    assert.equal(result.mutants[0].status, 'survived');
    assert.equal(result.mutants[0].confirmations, 2);
    assert.equal(result.attempts, 4);
  } finally { f.close(); }
});

test('Node v2 mutation refuses stale collected source before executing', () => {
  const f = fixture('assert.equal(math(2),3)');
  try {
    const collected = collect(f);
    writeFileSync(join(f.root, f.source), 'module.exports = value => value + 2;\n');
    assert.throws(() => mutate(f, collected), /input or environment differs from collected identity/);
  } finally { f.close(); }
});
