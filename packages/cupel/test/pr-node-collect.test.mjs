import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../src/collect/node/index.mjs';
import { collectNodeProfile } from '../src/pr/profiles/node/collect.mjs';
import { nodeProfileProducerProof } from '../src/pr/producer.mjs';
import { run } from '../src/engine/index.mjs';
import { loadSchemas } from '../src/cli/context.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-collect-root-'));
  const outputs = mkdtempSync(join(scratch, 'pr-collect-output-'));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'src/branch.cjs'),
    "module.exports = value => {\n  if (value) return 'yes';\n  return 'no';\n};\n");
  writeFileSync(join(root, 'tests/branch.test.cjs'),
    "const {test}=require('node:test');\nconst assert=require('node:assert/strict');\nconst branch=require('../src/branch.cjs');\ntest('yes [critical]',()=>assert.equal(branch(true),'yes'));\ntest('no [standard]',()=>assert.equal(branch(false),'no'));\n");
  return { root, outputs, file: 'tests/branch.test.cjs',
    config: { runners: { node: { tests: 'tests/**/*.test.cjs' } } },
    close() { rmSync(root, { recursive: true, force: true });
      rmSync(outputs, { recursive: true, force: true }); } };
}

test('Node 26 v2 collection constructs canonical source, test, coverage and static rows', async () => {
  const f = fixture();
  try {
    const expectedProducerHash = nodeProfileProducerProof().producerHash;
    const profile = collectNodeProfile({ root: f.root, files: [f.file],
      out: join(f.outputs, 'profile'), config: f.config, runs: 2, nodePath,
      expectedProducerHash });
    assert.equal(profile.kind, 'complete');
    assert.equal(profile.attempts.length, 2);
    assert.equal(profile.runRows.length, 2);
    assert.deepEqual(profile.runRows[0], profile.runRows[1]);
    const ordinary = await collectNode({ root: f.root, files: [f.file],
      config: f.config, runs: 2 });
    assert.deepEqual(profile.input.sources, ordinary.sources);
    assert.deepEqual(profile.input.tests.map(row => ({ id: row.id, file: row.file,
      name: row.name, tags: row.tags, status: row.status })),
    ordinary.tests.map(row => ({ id: row.id, file: row.file,
      name: row.name, tags: row.tags, status: row.status })));
    assert.deepEqual(profile.input.coverage.byTest, ordinary.coverage.byTest);
    assert.deepEqual(profile.input.coverage.setup, ordinary.coverage.setup);
    assert.deepEqual(profile.input.coverage.unstable, ordinary.coverage.unstable);
    assert.deepEqual(profile.input.shapes, ordinary.shapes);
    assert.deepEqual(profile.input.brittleness, ordinary.brittleness);
    assert.ok(profile.observations[f.file].imports.includes('src/branch.cjs'));
    assert.deepEqual(profile.observations[f.file].writes, []);
    assert.ok(profile.observations[f.file].filesystemEvents.some(event =>
      event.path === 'src/branch.cjs' && event.origin === 'loader'));
    const validation = run('validate', { input: profile.input }, f.config, {}, loadSchemas());
    assert.equal(validation.exit, 0, JSON.stringify(validation.report.diagnostics));
  } finally { f.close(); }
});

test('Node v2 collection refuses Node 22 and unsupported runner setup before execution', () => {
  const f = fixture();
  try {
    const expectedProducerHash = nodeProfileProducerProof().producerHash;
    const args = { root: f.root, files: [f.file], out: join(f.outputs, 'node22'),
      config: f.config, expectedProducerHash };
    assert.throws(() => collectNodeProfile({ ...args,
      nodePath: '/opt/homebrew/opt/node@22/bin/node' }), /requires verified Node 26\.7\.0/);
    assert.throws(() => collectNodeProfile({ ...args,
      config: { runners: { node: { ...f.config.runners.node, prepare: 'echo hi' } } },
      nodePath }), /refuses unsupported node runner/);
  } finally { f.close(); }
});

test('full collection refuses an omitted discovered test file', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'tests/other.test.cjs'),
      "const {test}=require('node:test');test('other',()=>{});\n");
    assert.throws(() => collectNodeProfile({ root: f.root, files: [f.file],
      out: join(f.outputs, 'incomplete'), config: f.config, runs: 2,
      nodePath, expectedProducerHash: nodeProfileProducerProof().producerHash }),
    /full collection test inventory differs/);
  } finally { f.close(); }
});
