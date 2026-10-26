import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync,
  symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SOURCE_FACT_BYTES, SourceChangedError, SourceFacts,
  SourceFactsLimitError } from '../src/mutate/source-facts.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(repo, '.scratch/s17/source-facts-tests');
mkdirSync(scratch, { recursive: true });
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture() {
  const root = mkdtempSync(join(scratch, 'fixture-'));
  const source = 'src/math.mjs';
  const path = join(root, source);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'export const plus = n => n + 1;\n');
  const hash = sha(readFileSync(path));
  return { root, source, path, hash };
}

test('request fact pins bytes, declared hash and independent retained text', () => {
  const f = fixture();
  const metrics = {};
  const facts = new SourceFacts(f.root, { sources: { [f.source]: { hash: f.hash } } }, metrics);
  const initial = facts.readInitial(f.source);
  facts.retain(f.source, initial);
  assert.ok(Object.isFrozen(initial));
  assert.throws(() => { initial.text = 'caller changed this reference'; }, TypeError);
  assert.equal(initial.bytes, undefined);
  assert.equal(facts.assertFresh(f.source), 'export const plus = n => n + 1;\n');
  assert.equal(facts.size, 1);
  assert.equal(facts.retainedBytes, Buffer.byteLength('export const plus = n => n + 1;\n'));
  assert.equal(metrics.sourceReads, 3);
  assert.equal(metrics.sourceChecks, 1);
  assert.equal(metrics.factSources, 1);
  assert.equal(metrics.factBytes, facts.retainedBytes);
});

test('same-size same-mtime edit and changed declared hash fail closed', () => {
  const f = fixture();
  const facts = new SourceFacts(f.root, { sources: { [f.source]: { hash: f.hash } } });
  facts.retain(f.source, facts.readInitial(f.source));
  const old = statSync(f.path);
  writeFileSync(f.path, 'export const plus = n => n - 1;\n');
  utimesSync(f.path, old.atime, old.mtime);
  assert.equal(statSync(f.path).size, old.size);
  assert.throws(() => facts.assertFresh(f.source), error =>
    error instanceof SourceChangedError && error.exit === 3 && /bytes/.test(error.message));
  const mismatch = new SourceFacts(f.root, { sources: { [f.source]: { hash: f.hash } } });
  assert.throws(() => mismatch.retain(f.source, mismatch.readInitial(f.source)),
    /declared input hash/);
  assert.throws(() => new SourceFacts(f.root,
    { sources: { [f.source]: { hash: 'opaque-hash' } } }), /opaque or noncanonical/);
});

test('source rename, symlink retarget and root retarget cannot reuse source facts', () => {
  const renamed = fixture();
  const facts = new SourceFacts(renamed.root, { sources: { [renamed.source]: {} } });
  facts.retain(renamed.source, facts.readInitial(renamed.source));
  renameSync(renamed.path, `${renamed.path}.moved`);
  assert.throws(() => facts.assertFresh(renamed.source), /cannot be read/);

  const linkedSource = fixture();
  const targetA = `${linkedSource.path}.a`, targetB = `${linkedSource.path}.b`;
  renameSync(linkedSource.path, targetA);
  copyFileSync(targetA, targetB);
  symlinkSync(targetA, linkedSource.path);
  const sourceFacts = new SourceFacts(linkedSource.root,
    { sources: { [linkedSource.source]: {} } });
  sourceFacts.retain(linkedSource.source, sourceFacts.readInitial(linkedSource.source));
  unlinkSync(linkedSource.path);
  symlinkSync(targetB, linkedSource.path);
  assert.throws(() => sourceFacts.assertFresh(linkedSource.source), /bytes, path or retained fact differs/);

  const a = fixture(), b = fixture();
  const parent = mkdtempSync(join(scratch, 'linked-'));
  const link = join(parent, 'active');
  symlinkSync(a.root, link, 'dir');
  const linked = new SourceFacts(link, { sources: { [a.source]: {} } });
  linked.retain(a.source, linked.readInitial(a.source));
  unlinkSync(link);
  symlinkSync(b.root, link, 'dir');
  assert.throws(() => linked.assertFresh(a.source), /project root changed/);
});

test('corrupt caller fact and over-budget retention are explicit errors', () => {
  const f = fixture();
  const corrupt = new SourceFacts(f.root, { sources: { [f.source]: {} } });
  const initial = corrupt.readInitial(f.source);
  assert.throws(() => corrupt.retain(f.source, { ...initial, text: 'caller changed source text' }),
    /not issued for this request/);

  const large = fixture();
  truncateSync(large.path, MAX_SOURCE_FACT_BYTES + 1);
  const bounded = new SourceFacts(large.root, { sources: { [large.source]: {} } });
  const oversized = bounded.readInitial(large.source);
  assert.throws(() => bounded.retain(large.source, oversized), error =>
    error instanceof SourceFactsLimitError && error.exit === 3 && /exceed/.test(error.message));
  assert.equal(bounded.size, 0);
});

test('traversal, external symlink and private names refuse before reading bytes', () => {
  const f = fixture();
  const outside = `${f.root}-outside.mjs`;
  writeFileSync(outside, 'export const dummy = true;\n');
  const link = join(f.root, 'src', 'external.mjs');
  symlinkSync(outside, link);
  const privatePath = join(f.root, '.scratch', 'private.mjs');
  mkdirSync(dirname(privatePath), { recursive: true });
  writeFileSync(privatePath, 'export const dummy = true;\n');
  const credentialPath = join(f.root, 'credentials', 'fixture.mjs');
  mkdirSync(dirname(credentialPath), { recursive: true });
  writeFileSync(credentialPath, 'export const dummy = true;\n');
  const hardlinkPath = join(f.root, 'src', 'hardlink.mjs');
  linkSync(f.path, hardlinkPath);
  const directoryPath = join(f.root, 'src', 'directory.mjs');
  mkdirSync(directoryPath);
  const nonSourcePath = join(f.root, 'src', 'key.pem');
  writeFileSync(nonSourcePath, 'dummy test data\n');
  const names = [`../${outside.split('/').at(-1)}`, 'src/external.mjs',
    '.scratch/private.mjs', 'credentials/fixture.mjs', 'src/hardlink.mjs',
    'src/directory.mjs', 'src/key.pem'];
  const facts = new SourceFacts(f.root, { sources: Object.fromEntries(names.map(name => [name, {}])) });
  let reads = 0;
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => { reads++; return original(...args); };
  syncBuiltinESMExports();
  try {
    for (const name of names) assert.throws(() => facts.readInitial(name), error =>
      error instanceof SourceChangedError && error.exit === 3 && /refused before reading/.test(error.message));
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
});
