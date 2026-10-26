import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export function sourceHashes(root) {
  const hashes = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        if (!entry.isFile()) throw new Error(`non-regular source entry: ${relative(root, path)}`);
        hashes[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  }
  walk(root);
  return hashes;
}

export function sourceDigest(hashes) {
  const entries = Object.entries(hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const rows = entries.map(([path, hash]) => `${path}\0${hash}\n`).join('');
  return `sha256:${createHash('sha256').update(rows).digest('hex')}`;
}

export function assertFrozenSource(root, expected) {
  if (!/^sha256:[0-9a-f]{64}$/.test(expected)) throw new Error('missing or malformed frozen source digest');
  const hashes = sourceHashes(root);
  assert.equal(sourceDigest(hashes), expected, 'frozen mutation source changed');
  return hashes;
}

export function approvedPin(record) {
  if (record?.version !== 'cupel-s17-mutation-source/1' || record.status !== 'approved')
    throw new Error('mutation source pin is not approved');
  return record.digest;
}
