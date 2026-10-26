import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyInputSnapshot } from '../src/pr/profiles/node/inputs.mjs';
import { profileRequestSnapshot } from '../src/pr/profiles/node/snapshot.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const policy = 'express-root-npmrc-opaque-v1';
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-opaque-'));
  writeFileSync(join(root, '.npmrc'), 'synthetic-inaccessible-test-value\n');
  chmodSync(join(root, '.npmrc'), 0o000);
  return { root, close() { rmSync(root, { recursive: true, force: true }); } };
}

test('opaque preflight records presence without opening or hashing root .npmrc', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'safe.txt'), 'safe\n');
    const reads = [];
    const value = readOnlyInputSnapshot(f.root, { inputPolicy: policy,
      readFile(path) { reads.push(path); return Buffer.from('safe\n'); },
      hash(bytes) { assert.equal(bytes.toString(), 'safe\n'); return 'sha256:safe'; } });
    assert.equal(value.opaqueRootNpmrc, 'regular');
    assert.deepEqual(Object.keys(value.files), ['safe.txt']);
    assert.deepEqual(reads, [join(f.root, 'safe.txt')]);
    assert.throws(() => readOnlyInputSnapshot(f.root), /private input path/);
  } finally { f.close(); }
});

test('opaque policy refuses a package export mapped to private root file', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'package.json'),
      JSON.stringify({ name: 'fixture', exports: { '.': './.npmrc' } }));
    assert.throws(() => profileRequestSnapshot({ root: f.root, files: [],
      version: '26.7.0', inputPolicy: policy }), /private package module mapping/);
  } finally { f.close(); }
});

test('nested private filename refuses before any permitted content read', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'src'));
    writeFileSync(join(f.root, 'src', '.npmrc'), 'synthetic-test-only\n');
    assert.throws(() => readOnlyInputSnapshot(f.root, { inputPolicy: policy,
      readFile() { throw new Error('content read happened'); } }), /private input path/);
  } finally { f.close(); }
});
