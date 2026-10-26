import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inventoryMetadata, summarizeFsCounters } from './counters.mjs';

test('metadata inventory excludes opaque path before content or stat access', t => {
  const root = mkdtempSync(join(tmpdir(), 's16-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'safe.txt'), 'hello');
  writeFileSync(join(root, '.npmrc'), 'synthetic-only');
  assert.deepEqual(inventoryMetadata(root, { 'safe.txt': 'hash' }), { files: 1, bytes: 5 });
  assert.throws(() => inventoryMetadata(root, { '.npmrc': 'hash' }), /opaque/);
});

test('aggregate counters keep metadata, dependency, lock and runtime distinct', () => {
  assert.deepEqual(summarizeFsCounters({ calls: {
    'headInventory:readdirSync': 2, 'headInventory:lstatSync': 4,
    'headLockfile:readFileSync': 1, 'headDependencies:readFileSync': 3,
    'trustedProfile:readFileSync': 2, 'coordinator:readFileSync': 1,
    'transitiveProducer:readFileSync': 2,
  }, readBytes: { headInventory: 100 } }), {
    metadataCalls: 6, directoryScans: 2, fileReads: 9,
    returnedBytes: { headInventory: 100 }, lockfileReads: 1,
    dependencyReads: 3, trustedRuntimeReads: 5,
  });
});
