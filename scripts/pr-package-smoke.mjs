import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Reused against source and the offline npm install. Never executes the project
// being developed: this creates and commits a separate, disposable subject.
export function prPackageSmoke({ scratch, bin, checked, nodePath, inputPolicy = 'strict-v1' }) {
  const project = join(scratch, 'pr-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'tests'));
  const config = { runners: { node: { tests: 'tests/**/*.test.cjs' } } };
  writeFileSync(join(project, 'cupel.json'), JSON.stringify(config));
  writeFileSync(join(project, 'src/auth.cjs'), 'module.exports = value => value + 1;\n');
  const testPath = join(project, 'tests/a.test.cjs');
  const original = "const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');test('a [critical]',()=>assert.equal(auth(2),3));\n";
  writeFileSync(testPath, original);
  writeFileSync(join(project, 'tests/b.test.cjs'),
    "const {test}=require('node:test');test('b',()=>{});\n");
  if (inputPolicy === 'express-root-npmrc-opaque-v1') writeFileSync(join(project, '.npmrc'), '');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => checked('git', ['-C', project, ...args], { env: gitEnv });
  const commit = () => {
    git('add', '-A');
    git('-c', 'user.name=Cupel Smoke', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'fixture', '-m',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  };
  git('init', '-q'); commit();
  const base = git('rev-parse', 'HEAD').stdout.trim();
  const execute = (args, extra = {}) => checked(process.execPath, [bin, ...args], { cwd: project, ...extra });
  const producer = JSON.parse(execute(['pr-producer', '--json']).stdout);
  assert.match(producer.producerHash, /^sha256:[0-9a-f]{64}$/);
  const common = ['--profile', 'node-readonly-files-v2', '--base', base,
    '--producer-sha256', producer.producerHash, '--node', nodePath,
    '--input-policy', inputPolicy, '--json'];
  const prepared = JSON.parse(execute(['pr-prepare', ...common,
    '--work-dir', join(scratch, 'pr-prepare'), '--out', join(scratch, 'pr-baseline.json')]).stdout);
  assert.equal(prepared.kind, 'prepared');
  const request = ['pr', ...common, '--baseline', prepared.artifact.path,
    '--baseline-sha256', prepared.artifact.sha256];
  const clean = JSON.parse(execute([...request, '--work-dir', join(scratch, 'pr-clean'),
    '--out', join(scratch, 'pr-clean.json')]).stdout);
  assert.equal(clean.spec, 'cupel-pr-result/1');
  assert.equal(clean.wholeGuardPass, false);
  assert.equal(clean.exit, 0);
  assert.equal(clean.privacyPolicy, inputPolicy);
  assert.equal(clean.executedFiles.length, 1);
  assert.equal(clean.unexecutedFiles.length, 1);

  writeFileSync(testPath, original.replace('assert.equal(auth(2),3)', 'assert.equal(auth(2),auth(2))'));
  commit();
  const rpc = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'cupel_pr', arguments: { profile: 'node-readonly-files-v2', base,
      producerSha256: producer.producerHash, node: nodePath,
      inputPolicy,
      baseline: prepared.artifact.path, baselineSha256: prepared.artifact.sha256,
      workDir: join(scratch, 'pr-weakened'), out: join(scratch, 'pr-weakened.json') } } })}\n`;
  const mcp = JSON.parse(execute(['mcp', '--root', project], { input: rpc }).stdout);
  assert.equal(mcp.result.isError, false); // An executed regression is exit 1, not a protocol error.
  const weak = JSON.parse(mcp.result.content[1].text);
  assert.equal(weak.exit, 1);
  assert.equal(weak.wholeGuardPass, false);
  assert.equal(weak.comparison.mutation.lostKills.length, 1);
  assert.equal(weak.executedFiles.length, 1);
  assert.equal(weak.unexecutedFiles.length, 1);
  assert.equal(weak.mutation.mutants[0].confirmations, 2);

  const negative = (args, status, pattern) => {
    const value = spawnSync(process.execPath, [bin, ...args], {
      cwd: project, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.ifError(value.error);
    assert.equal(value.status, status, `${value.stderr}\n${value.stdout}`);
    assert.match(value.stderr, pattern);
  };
  negative(['pr', ...common], 2, /--work-dir/);
  negative([...request, '--baseline-sha256', `sha256:${'0'.repeat(64)}`,
    '--work-dir', join(scratch, 'pr-stale'), '--out', join(scratch, 'pr-stale.json')],
  3, /bytes differ from trusted pin/);
  if (process.versions.node.startsWith('22.'))
    negative([...request, '--node', process.execPath,
      '--work-dir', join(scratch, 'pr-node22'), '--out', join(scratch, 'pr-node22.json')],
    3, /requires Node 26\.7\.0/);
  writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\n`);
  negative([...request, '--work-dir', join(scratch, 'pr-dirty'),
    '--out', join(scratch, 'pr-dirty.json')], 3, /tracked bytes differ from exact HEAD/);
  return { profile: 'node-readonly-files-v2', runtime: nodePath, inputPolicy,
    producerHash: producer.producerHash, baseline: prepared.artifact,
    clean: { exit: clean.exit, executed: clean.executedFiles.length,
      unexecuted: clean.unexecutedFiles.length, costs: clean.costs },
    weakened: { exit: weak.exit, lostKills: weak.comparison.mutation.lostKills.length,
      confirmations: weak.mutation.mutants[0].confirmations, costs: weak.costs },
    preparationCosts: prepared.costs,
    node22RefusalVerified: process.versions.node.startsWith('22.'),
    checks: ['cli-prepare', 'cli-selected-control', 'mcp-lost-kill', 'missing-arguments', 'bad-baseline-pin', 'dirty-head'] };
}
