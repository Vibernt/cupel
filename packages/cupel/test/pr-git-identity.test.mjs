import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactGitBaseline } from '../src/pr/git-identity.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-git-root-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/math.cjs'), 'module.exports = 1;\n');
  git(root, 'init', '-q');
  git(root, 'add', 'src/math.cjs');
  git(root, '-c', 'user.name=Cupel Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'fixture', '-m',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  return { root, commit: git(root, 'rev-parse', 'HEAD'),
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('exact Git baseline binds HEAD, index and current tracked bytes', () => {
  const f = fixture();
  try {
    const identity = assertExactGitBaseline(f);
    assert.equal(identity.commit, f.commit);
    assert.equal(identity.fileCount, 1);
    assert.match(identity.tree, /^[0-9a-f]{40}$/);
  } finally { f.close(); }
});

test('exact Git baseline refuses same-size edits, untracked files and index changes', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src/math.cjs'), 'module.exports = 2;\n');
    assert.throws(() => assertExactGitBaseline(f), /tracked bytes differ/);
    writeFileSync(join(f.root, 'src/math.cjs'), 'module.exports = 1;\n');
    writeFileSync(join(f.root, 'untracked.txt'), 'data\n');
    assert.throws(() => assertExactGitBaseline(f), /worktree inventory differs/);
    git(f.root, 'add', 'untracked.txt');
    assert.throws(() => assertExactGitBaseline(f), /index differs/);
  } finally { f.close(); }
});

test('private filename refuses before Git worktree byte checking', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '.env'), 'SECRET=never-print\n');
    assert.throws(() => assertExactGitBaseline(f), /private input path/);
  } finally { f.close(); }
});

test('explicit opaque Git baseline binds tracked metadata without reading root .npmrc', () => {
  const f = fixture();
  try {
    const opaque = join(f.root, '.npmrc');
    writeFileSync(opaque, 'synthetic-inaccessible-test-value\n');
    git(f.root, 'add', '.npmrc');
    git(f.root, '-c', 'user.name=Cupel Test', '-c', 'user.email=test@example.invalid',
      'commit', '-q', '-m', 'opaque fixture', '-m',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    const commit = git(f.root, 'rev-parse', 'HEAD');
    chmodSync(opaque, 0o000);
    assert.throws(() => assertExactGitBaseline({ root: f.root, commit }), /private input path/);
    const policy = 'express-root-npmrc-opaque-v1';
    const evidence = assertExactGitBaseline({ root: f.root, commit, inputPolicy: policy });
    assert.equal(evidence.opaqueRootNpmrc, 'regular');
    assert.equal(evidence.opaqueGit.path, '.npmrc');
    assert.match(evidence.opaqueGit.oid, /^[0-9a-f]{40}$/);
    assert.equal(Object.hasOwn(evidence.inputManifest, '.npmrc'), false);
    assert.equal(evidence.fileCount, 2);
    chmodSync(opaque, 0o600);
    writeFileSync(opaque, 'different-known-test-bytes\n');
    chmodSync(opaque, 0o000);
    assert.deepEqual(assertExactGitBaseline({ root: f.root, commit, inputPolicy: policy }), evidence);
  } finally { f.close(); }
});

test('opaque root alias and nested private names refuse before content reads', () => {
  const f = fixture();
  try {
    const policy = 'express-root-npmrc-opaque-v1';
    symlinkSync('src/math.cjs', join(f.root, '.npmrc'));
    assert.throws(() => assertExactGitBaseline({ ...f, inputPolicy: policy }), /opaque root .npmrc alias/);
    rmSync(join(f.root, '.npmrc'));
    linkSync(join(f.root, 'src/math.cjs'), join(f.root, '.npmrc'));
    assert.throws(() => assertExactGitBaseline({ ...f, inputPolicy: policy }), /opaque root .npmrc alias/);
    rmSync(join(f.root, '.npmrc'));
    writeFileSync(join(f.root, 'src/.npmrc'), 'synthetic-test-value\n');
    assert.throws(() => assertExactGitBaseline({ ...f, inputPolicy: policy }), /private input path/);
  } finally { f.close(); }
});
