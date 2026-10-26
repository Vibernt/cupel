import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNodeProfileBaseline } from '../src/pr/prepare.mjs';
import { runNodeProfileRequest } from '../src/pr/request.mjs';
import { nodeProfileProducerProof } from '../src/pr/producer.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(root, files = ['-A']) {
  git(root, 'add', ...files);
  git(root, '-c', 'user.name=Cupel Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'fixture', '-m',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
}
function fixture({ criticalBody = 'assert.equal(auth(2),3)',
  secondCritical = false, extraBranch = false, opaqueRoot = false } = {}) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-request-root-'));
  const output = mkdtempSync(join(scratch, 'pr-request-output-'));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'src/auth.cjs'), 'module.exports = value => value + 1;\n');
  if (extraBranch) writeFileSync(join(root, 'src/branch.cjs'),
    'module.exports = value => {\n  if (value) {\n    return 1;\n  }\n  return 2;\n};\n');
  const body = extraBranch ? '{assert.equal(auth(2),3);branch(1);branch(0)}' : criticalBody;
  const branchImport = extraBranch ? "const branch=require('../src/branch.cjs');" : '';
  writeFileSync(join(root, 'tests/a.test.cjs'),
    `const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');${branchImport}test('a [critical]',()=>${body});\n`);
  writeFileSync(join(root, 'tests/b.test.cjs'),
    secondCritical ?
      "const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');test('b [critical]',()=>assert.equal(auth(4),5));\n" :
      "const {test}=require('node:test');const auth=require('../src/auth.cjs');test('b',()=>{auth(4)});\n");
  writeFileSync(join(root, 'README.md'), 'original\n');
  if (opaqueRoot) writeFileSync(join(root, '.npmrc'), 'synthetic-private-fixture-value\n');
  const config = { runners: { node: { tests: 'tests/**/*.test.cjs' } } };
  writeFileSync(join(root, 'cupel.json'), `${JSON.stringify(config)}\n`);
  git(root, 'init', '-q'); commit(root);
  if (opaqueRoot) chmodSync(join(root, '.npmrc'), 0o000);
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const inputPolicy = opaqueRoot ? 'express-root-npmrc-opaque-v1' : 'strict-v1';
  const expectedProducerHash = nodeProfileProducerProof().producerHash;
  const prepared = prepareNodeProfileBaseline({ root, baseCommit,
    files: ['tests/a.test.cjs', 'tests/b.test.cjs'],
    out: join(output, 'prepare'), artifactPath: join(output, 'baseline.json'),
    config, nodePath, expectedProducerHash, inputPolicy });
  let serial = 0;
  return { root, output, baseCommit, expectedProducerHash, prepared,
    request(overrides = {}) { const count = serial++;
      return runNodeProfileRequest({ root, baseCommit,
        baselinePath: prepared.artifact.path,
        expectedBaselineHash: prepared.artifact.sha256, expectedProducerHash,
        nodePath, out: join(output, `request-${count}`),
        resultPath: join(output, `result-${count}.json`), inputPolicy, ...overrides }); },
    close() { rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true }); } };
}

test('clean Node PR request executes a scoped control, never a whole guard', () => {
  const f = fixture();
  try {
    const value = f.request();
    assert.equal(value.exit, 0);
    assert.equal(value.report.spec, 'cupel-pr-result/1');
    assert.equal(value.report.wholeGuardPass, false);
    assert.equal(value.report.route, 'selected');
    assert.equal(value.report.executedFiles.length, 1);
    assert.equal(value.report.unexecutedFiles.length, 1);
    assert.equal(JSON.parse(readFileSync(value.result.path)).exit, 0);
  } finally { f.close(); }
});

test('weakened critical assertion loses a verified baseline kill', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'tests/a.test.cjs'),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');test('a [critical]',()=>assert.equal(auth(2),auth(2)));\n");
    commit(f.root, ['tests/a.test.cjs']);
    const value = f.request();
    assert.equal(value.exit, 1);
    assert.equal(value.report.complete, true);
    assert.equal(value.report.route, 'selected');
    assert.equal(value.report.comparison.mutation.lostKills.length, 1);
    assert.equal(value.report.mutation.mutants[0].status, 'survived');
  } finally { f.close(); }
});

test('request refuses an uncommitted HEAD instead of using stale scoped evidence', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src/auth.cjs'), 'module.exports = value => value + 2;\n');
    assert.throws(() => f.request(), /tracked bytes differ from exact HEAD/);
  } finally { f.close(); }
});

test('changed critical source uses verified HEAD line scope', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src/auth.cjs'),
      'module.exports = value => value + 1; // reviewed comment\n');
    commit(f.root);
    const value = f.request();
    assert.equal(value.exit, 0);
    assert.equal(value.report.route, 'selected');
    assert.equal(value.report.mutationScope.kind, 'changed-critical-lines');
    assert.equal(value.report.mutationScope.lineSides['src/auth.cjs'].head, '1');
    assert.ok(value.report.mutationScope.sites.length > 0);
  } finally { f.close(); }
});

test('removed killed site on changed critical source refuses instead of passing', () => {
  const f = fixture({ criticalBody: 'assert.ok(auth(2)>1)' });
  try {
    writeFileSync(join(f.root, 'src/auth.cjs'),
      'module.exports = value => value;\n');
    // The original test still passes, but no HEAD site exists for its old kill.
    commit(f.root);
    assert.throws(() => f.request(), /lost a previously killed baseline site/);
  } finally { f.close(); }
});

test('skipped former critical test refuses even if another test still kills', () => {
  const f = fixture({ secondCritical: true });
  try {
    writeFileSync(join(f.root, 'tests/a.test.cjs'),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');test.skip('a [critical]',()=>assert.equal(auth(2),3));\n");
    commit(f.root);
    assert.throws(() => f.request(), /previously passing selected test is now skipped/);
  } finally { f.close(); }
});

test('edited critical test loses its own kill even when another test still kills', () => {
  const f = fixture({ secondCritical: true });
  try {
    writeFileSync(join(f.root, 'tests/a.test.cjs'),
      "const {test}=require('node:test');const assert=require('node:assert/strict');test('a [critical]',()=>assert.ok(true));\n");
    commit(f.root);
    const value = f.request();
    assert.equal(value.exit, 1);
    assert.equal(value.report.comparison.mutation.lostKills.length, 0);
    assert.equal(value.report.comparison.mutation.lostKillers.length, 1);
    assert.match(value.report.comparison.mutation.lostKillers[0].test, /a \[critical\]/);
    assert.equal(value.report.mutation.mutants[0].status, 'killed');
  } finally { f.close(); }
});

test('edited critical test loses an unchanged branch line with no lost mutant', () => {
  const f = fixture({ secondCritical: true, extraBranch: true });
  try {
    writeFileSync(join(f.root, 'tests/a.test.cjs'),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const auth=require('../src/auth.cjs');const branch=require('../src/branch.cjs');test('a [critical]',()=>{assert.equal(auth(2),3);branch(1)});\n");
    commit(f.root);
    const value = f.request();
    assert.equal(value.exit, 1);
    assert.deepEqual(value.report.comparison.mutation.lostKillers, []);
    assert.ok(value.report.comparison.lostCoverage.some(row =>
      row.test.includes('a [critical]') && row.source === 'src/branch.cjs'));
  } finally { f.close(); }
});

test('noncode change takes declared profile-full route', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'README.md'), 'revised\n');
    commit(f.root);
    const value = f.request();
    assert.equal(value.exit, 0);
    assert.equal(value.report.route, 'profile-full');
    assert.deepEqual(value.report.executedFiles,
      ['tests/a.test.cjs', 'tests/b.test.cjs']);
    assert.deepEqual(value.report.unexecutedFiles, []);
    assert.equal(value.report.mutationScope.kind, 'full-critical-sources');
  } finally { f.close(); }
});

test('Node 22 PR request refuses before subject execution', () => {
  const f = fixture();
  try {
    assert.throws(() => f.request({ nodePath: realpathSync('/opt/homebrew/opt/node@22/bin/node') }),
      /requires Node 26\.7\.0/);
  } finally { f.close(); }
});

test('request refuses an output parent alias into the subject root', () => {
  const f = fixture();
  try {
    symlinkSync(f.root, join(f.output, 'alias'), 'dir');
    assert.throws(() => f.request({ out: join(f.output, 'alias', 'request') }),
      /output ancestor is symlinked/);
  } finally { f.close(); }
});

test('explicit opaque root policy prepares and runs without credential content access', () => {
  const f = fixture({ opaqueRoot: true });
  try {
    const value = f.request();
    assert.equal(value.exit, 0);
    assert.equal(value.report.privacyPolicy, 'express-root-npmrc-opaque-v1');
    assert.equal(value.report.executedFiles.length, 1);
    assert.equal(value.report.unexecutedFiles.length, 1);
  } finally { f.close(); }
});

test('opaque request refuses policy mismatch and changed tracked metadata', () => {
  const f = fixture({ opaqueRoot: true });
  try {
    assert.throws(() => f.request({ inputPolicy: 'strict-v1' }), /privacy policy differs/);
    chmodSync(join(f.root, '.npmrc'), 0o600);
    writeFileSync(join(f.root, '.npmrc'), 'different-synthetic-private-fixture-value\n');
    commit(f.root);
    chmodSync(join(f.root, '.npmrc'), 0o000);
    assert.throws(() => f.request(), /opaque root metadata differs/);
  } finally { f.close(); }
});

test('opaque request refuses a caught test access to root .npmrc', () => {
  const f = fixture({ opaqueRoot: true });
  try {
    writeFileSync(join(f.root, 'tests/a.test.cjs'),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const auth=require('../src/auth.cjs');test('a [critical]',()=>{try{fs.readFileSync('.npmrc')}catch{}assert.equal(auth(2),3)});\n");
    commit(f.root, ['tests/a.test.cjs']);
    assert.throws(() => f.request(), /refused|private|denial/);
  } finally { f.close(); }
});
