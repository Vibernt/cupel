import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeProfileProducerProof, packageSourceManifest } from '../src/pr/producer.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));

test('Node PR producer pins installed source and schemas deterministically', () => {
  const first = nodeProfileProducerProof(), second = nodeProfileProducerProof();
  assert.deepEqual(first, second);
  assert.match(first.producerHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(first.sourceCount > 20);
});

test('producer manifest changes with a same-length source edit', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-producer-test-'));
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'schemas'));
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'src/a.mjs'), 'export const value = 1;\n');
    writeFileSync(join(root, 'schemas/a.json'), '{}\n');
    const first = packageSourceManifest(root);
    writeFileSync(join(root, 'src/a.mjs'), 'export const value = 2;\n');
    const second = packageSourceManifest(root);
    assert.notDeepEqual(first, second);
    assert.deepEqual(first.map(row => row[0]), ['package.json', 'schemas/a.json', 'src/a.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
