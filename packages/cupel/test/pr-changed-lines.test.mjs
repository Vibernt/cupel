import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedHeadLines, changedLineSides, changedCriticalSourceLines,
  changedCriticalSourceLineSides } from '../src/pr/changed-lines.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('bounded line comparison records added/replaced HEAD lines without inventing deleted lines', () => {
  assert.equal(changedHeadLines(['a', 'b', 'c'], ['a', 'B', 'c', 'd']), '2,4');
  assert.equal(changedHeadLines(['a', 'b', 'c'], ['a', 'c']), '');
  assert.deepEqual(changedLineSides(['a', 'b', 'c'], ['a', 'c']),
    { base: '2', head: '' });
  assert.throws(() => changedHeadLines(['a', 'b'], ['A', 'B'], 4), /bounded matrix/);
});

test('changed critical source binds exact Git blob and fresh HEAD bytes', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-changed-root-'));
  try {
    mkdirSync(join(root, 'src'));
    const source = 'src/auth.cjs';
    const base = 'const a = 1;\nconst b = 2;\n', head = 'const a = 1;\nconst b = 3;\n';
    writeFileSync(join(root, source), base);
    git(root, 'init', '-q'); git(root, 'add', source);
    git(root, '-c', 'user.name=Cupel Test', '-c', 'user.email=test@example.invalid',
      'commit', '-q', '-m', 'fixture', '-m',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    const baseCommit = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, source), head);
    const args = { root, source, baseCommit, baseHash: sha(base), headHash: sha(head) };
    assert.equal(changedCriticalSourceLines(args), '2');
    assert.deepEqual(changedCriticalSourceLineSides(args), { base: '2', head: '2' });
    assert.throws(() => changedCriticalSourceLines({ ...args, headHash: sha(base) }),
      /HEAD source bytes differ/);
    assert.throws(() => changedCriticalSourceLines({ ...args, baseHash: sha(head) }),
      /base source bytes differ/);
    assert.throws(() => changedCriticalSourceLines({ ...args, source: '.npmrc' }),
      /identity or path invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
