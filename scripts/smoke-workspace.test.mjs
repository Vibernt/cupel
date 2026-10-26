import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSmokeWorkspace } from './smoke-workspace.mjs';

test('package smoke workspace preserves old evidence across repeated runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-smoke-workspace-test-'));
  const oldResult = join(root, 'result.json');
  const sentinel = join(root, 'keep-me.txt');
  writeFileSync(oldResult, '{"old":true}\n');
  writeFileSync(sentinel, 'existing evidence\n');

  const first = createSmokeWorkspace(root);
  const firstResult = join(first, 'result.json');
  writeFileSync(firstResult, '{"run":1}\n');
  const second = createSmokeWorkspace(root);
  writeFileSync(join(second, 'result.json'), '{"run":2}\n');

  assert.notEqual(first, second);
  assert.equal(readFileSync(oldResult, 'utf8'), '{"old":true}\n');
  assert.equal(readFileSync(sentinel, 'utf8'), 'existing evidence\n');
  assert.equal(readFileSync(firstResult, 'utf8'), '{"run":1}\n');
});
