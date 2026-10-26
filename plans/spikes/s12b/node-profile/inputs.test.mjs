import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readOnlyInventory } from './inputs.mjs';
import { nodeProfileIdentity } from './launch.mjs';

const fixture = fn => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-node-inputs-'));
  try { return fn(root); }
  finally { rmSync(root, {recursive:true, force:true}); }
};
const dummy = 'DUMMY_CREDENTIAL_VALUE_FOR_TEST_ONLY';

for (const name of ['.env', '.env.local', 'credentials.json', 'credentials-dev.json', 'client.pem', 'private.key', 'bundle.p12',
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'application_default_credentials.json',
  'credentials.db', 'access_tokens.db']) {
  test(`private filename ${name} is refused before read or hash`, () => fixture(root => {
    writeFileSync(join(root, name), dummy);
    let reads = 0; let hashes = 0;
    assert.throws(() => readOnlyInventory(root, {
      readFile: path => { reads++; return readFileSync(path); },
      hash: bytes => { hashes++; return `unexpected:${bytes.length}`; },
    }), error => {
      assert.match(error.message, /private input path \(filename preflight\)/);
      assert.equal(error.message.includes(dummy), false);
      return true;
    });
    assert.equal(reads, 0);
    assert.equal(hashes, 0);
  }));
}

test('private filename preflight wins before symlink metadata checks', () => fixture(root => {
  writeFileSync(join(root, 'ordinary.txt'), dummy);
  symlinkSync(join(root, 'ordinary.txt'), join(root, 'credentials-test.json'));
  assert.throws(() => readOnlyInventory(root), /private input path \(filename preflight\)/);
}));

test('known credential directories are refused before descendants are read', () => fixture(root => {
  mkdirSync(join(root, '.ssh'));
  writeFileSync(join(root, '.ssh', 'config'), dummy);
  let reads = 0;
  assert.throws(() => readOnlyInventory(root, {readFile: path => { reads++; return readFileSync(path); }}),
    /private input path \(filename preflight\)/);
  assert.equal(reads, 0);
}));

test('full path preflight precedes reads of earlier ordinary files', () => fixture(root => {
  writeFileSync(join(root, 'a-ordinary.txt'), 'ordinary fixture');
  mkdirSync(join(root, 'credentials'));
  writeFileSync(join(root, 'credentials', 'token.txt'), dummy);
  let reads = 0; let hashes = 0;
  assert.throws(() => readOnlyInventory(root, {
    readFile: path => { reads++; return readFileSync(path); },
    hash: bytes => { hashes++; return `unexpected:${bytes.length}`; },
  }), /private input path \(filename preflight\)/);
  assert.equal(reads, 0);
  assert.equal(hashes, 0);
}));

test('.config/gcloud is treated as a known credential directory', () => fixture(root => {
  mkdirSync(join(root, '.config', 'gcloud'), {recursive:true});
  writeFileSync(join(root, '.config', 'gcloud', 'active_config'), dummy);
  assert.throws(() => readOnlyInventory(root), /private input path \(filename preflight\)/);
}));

test('Git metadata is excluded entirely, including credential-looking entries', () => fixture(root => {
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', '.env'), dummy);
  writeFileSync(join(root, '.git', 'credentials.json'), dummy);
  writeFileSync(join(root, 'test.js'), 'export const ok = true;\n');
  const inventory = readOnlyInventory(root);
  assert.deepEqual(Object.keys(inventory), ['test.js']);
}));

test('ordinary content remains identity-bearing', () => fixture(root => {
  const file = join(root, 'test.js');
  writeFileSync(file, 'export const value = 1;\n');
  const first = nodeProfileIdentity({root, files:['test.js'], version:'26.7.0'});
  writeFileSync(file, 'export const value = 2;\n');
  const second = nodeProfileIdentity({root, files:['test.js'], version:'26.7.0'});
  assert.notEqual(first.inputManifestHash, second.inputManifestHash);
}));

test('symlinks remain rejected', () => fixture(root => {
  writeFileSync(join(root, 'target.js'), 'export {};\n');
  symlinkSync(join(root, 'target.js'), join(root, 'alias.js'));
  assert.throws(() => readOnlyInventory(root), /refuses symlink/);
}));

test('symlinked inventory roots remain rejected', () => fixture(root => {
  const target = join(root, 'target');
  mkdirSync(target);
  symlinkSync(target, join(root, 'alias'));
  assert.throws(() => readOnlyInventory(join(root, 'alias')), /symlinked or non-directory input root/);
}));

test('non-regular filesystem entries remain rejected', t => fixture(root => {
  const fifo = join(root, 'pipe');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.error || made.status !== 0) { t.skip('mkfifo unavailable on this platform'); return; }
  assert.throws(() => readOnlyInventory(root), /refuses non-file input/);
}));

test('node_modules remains rejected before reading package contents', () => fixture(root => {
  mkdirSync(join(root, 'node_modules', 'pkg'), {recursive:true});
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'export {};\n');
  let reads = 0;
  assert.throws(() => readOnlyInventory(root, {readFile: path => { reads++; return readFileSync(path); }}),
    /refuses package dependencies/);
  assert.equal(reads, 0);
}));
