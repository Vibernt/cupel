import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPinnedFile, readPinnedFile } from './copy-safe.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/s23/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('derived copy verifies exact safe regular bytes and rejects private or aliased files', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'safe-copy-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    mkdirSync(source); mkdirSync(target);
    writeFileSync(join(source, 'safe.mjs'), 'export default 1;\n');
    const pin = sha('export default 1;\n');
    assert.equal(copyPinnedFile(source, target, 'safe.mjs', pin), 18);
    assert.equal(readFileSync(join(target, 'safe.mjs'), 'utf8'), 'export default 1;\n');
    assert.throws(() => readPinnedFile(source, 'safe.mjs', sha('other')), /changed/);
    writeFileSync(join(source, '.npmrc'), 'synthetic-test-only\n');
    chmodSync(join(source, '.npmrc'), 0o000);
    assert.throws(() => readPinnedFile(source, '.npmrc', sha('synthetic-test-only\n')),
      /path or digest invalid/);
    symlinkSync('safe.mjs', join(source, 'alias.mjs'));
    assert.throws(() => readPinnedFile(source, 'alias.mjs', pin), /unique regular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
