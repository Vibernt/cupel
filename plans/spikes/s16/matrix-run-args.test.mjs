import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('matrix refuses a raw name that breaks the Node profile temporary path', () => {
  const raw = resolve(import.meta.dirname, '../../../.scratch/s16/oracle/',
    'name-too-long-for-profile');
  assert.equal(existsSync(raw), false);
  const script = join(import.meta.dirname, 'matrix-run.mjs');
  const run = spawnSync(process.execPath,
    [script, process.execPath, 'strict-v1', raw], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /raw name exceeds 12 bytes/);
  assert.equal(existsSync(raw), false);
});
