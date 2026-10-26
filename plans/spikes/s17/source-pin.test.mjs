import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedPin, assertFrozenSource, sourceDigest, sourceHashes } from './source-pin.mjs';

test('frozen source pin rejects altered bytes and malformed pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s17-pin-'));
  try {
    writeFileSync(join(root, 'a.mjs'), 'export const x = 1;\n');
    const digest = sourceDigest(sourceHashes(root));
    assert.deepEqual(Object.keys(assertFrozenSource(root, digest)), ['a.mjs']);
    writeFileSync(join(root, 'a.mjs'), 'export const x = 2;\n');
    assert.throws(() => assertFrozenSource(root, digest), /frozen mutation source changed/);
    assert.throws(() => assertFrozenSource(root, 'sha256:abc'), /malformed frozen source digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('revoked and malformed source pins refuse before measurement', () => {
  const digest = `sha256:${'0'.repeat(64)}`;
  assert.equal(approvedPin({ version:'cupel-s17-mutation-source/1', status:'approved', digest }), digest);
  assert.throws(() => approvedPin({ version:'cupel-s17-mutation-source/1', status:'revoked', digest }), /not approved/);
  assert.throws(() => approvedPin({ status:'approved', digest }), /not approved/);
});
