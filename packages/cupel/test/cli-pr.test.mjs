import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prPackageSmoke } from '../../../scripts/pr-package-smoke.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';
function checked(command, args, options) {
  const value = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000,
    maxBuffer: 16 << 20, ...options });
  assert.ifError(value.error);
  assert.equal(value.status, 0, `${value.stderr}\n${value.stdout}`);
  return value;
}

test('explicit Node selective CLI and MCP preserve scope, pins, refusals and lost kills', () => {
  const scratchRoot = join(root, '.scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'cli-pr-'));
  try {
    const result = prPackageSmoke({ scratch,
      bin: join(root, 'packages/cupel/bin/cupel.mjs'), checked, nodePath });
    assert.equal(result.weakened.lostKills, 1);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('CLI and MCP explicitly bind the approved opaque input policy', () => {
  const scratchRoot = join(root, '.scratch'); mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'cli-pr-opaque-'));
  try {
    const result = prPackageSmoke({ scratch,
      bin: join(root, 'packages/cupel/bin/cupel.mjs'), checked, nodePath,
      inputPolicy: 'express-root-npmrc-opaque-v1' });
    assert.equal(result.inputPolicy, 'express-root-npmrc-opaque-v1');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
