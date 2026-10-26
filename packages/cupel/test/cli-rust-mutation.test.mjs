import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustPackageSmoke } from '../../../scripts/rust-package-smoke.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function checked(command, args, options) {
  const value = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000,
    maxBuffer: 16 << 20, ...options });
  assert.ifError(value.error);
  assert.equal(value.status, 0, `${value.stderr}\n${value.stdout}`);
  return value;
}
test('restricted Rust CLI collects source identities and guards a lost mutation kill', () => {
  const scratchRoot = join(root, '.scratch'); mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'cli-rust-'));
  try {
    const result = rustPackageSmoke({ root, scratch,
      bin: join(root, 'packages/cupel/bin/cupel.mjs'), checked });
    assert.equal(result.killed, 1);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
