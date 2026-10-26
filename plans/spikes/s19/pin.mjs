import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PRODUCT_MUTATE_HASH = '9e24423e3e5f3674d5608dcd7b84d31bf278b26e16bb79820b6e9caf9b12646f';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function sourceHashes(root) {
  const rows = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        if (!entry.isFile()) throw new Error(`non-regular source: ${relative(root, path)}`);
        rows.push([relative(root, path).split('\\').join('/'), sha256(readFileSync(path))]);
      }
    }
  }
  visit(root);
  return rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export function sourceDigest(root) {
  return sha256(sourceHashes(root).map(([path, hash]) => `${path}\0${hash}\n`).join(''));
}

export function assertSource(root, expected) {
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(sourceDigest(root), expected, `source tree changed: ${root}`);
}
