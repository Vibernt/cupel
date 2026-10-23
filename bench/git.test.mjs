import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitChangedLines } from './git.mjs';

test('plan replay includes changed test files in full beside source line ranges', async () => {
  mkdirSync('.scratch', { recursive: true });
  const dir = mkdtempSync('.scratch/bench-git-');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    git('config', 'user.name', 'Cupel Test');
    git('config', 'user.email', 'cupel@example.invalid');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/a.test.ts'), 'test("a", () => {});\n');
    git('add', '.'); git('commit', '-qm', 'base');
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'src/a.test.ts'), 'test("a", () => { expect(2).toBe(2); });\n');
    git('add', '.'); git('commit', '-qm', 'change');
    assert.deepEqual(await commitChangedLines({ dir }, git('rev-parse', 'HEAD')),
      { 'src/a.test.ts': '', 'src/a.ts': '1' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
