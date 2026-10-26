import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSession, newProfile, profileData, selectMethod, transformSelect } from './instrument.mjs';
import { assertSource, PRODUCT_MUTATE_HASH, sourceDigest } from './pin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const index = readFileSync(join(repo, 'packages/cupel/src/mutate/index.mjs'), 'utf8');

test('checked selector transform preserves anchors and requires explicit profile', () => {
  assertSource(join(repo, 'packages/cupel/src/mutate'), PRODUCT_MUTATE_HASH);
  assert.equal(selectMethod(index).method.match(/parseLines\(/g).length, 2);
  const full = exportSession(transformSelect(index));
  assert.match(full, /profile\.repeatedParseNs/);
  assert.match(full, /export \{ Session \}/);
  const outer = exportSession(transformSelect(index, 'outer'));
  assert.doesNotMatch(outer, /profile\.repeatedParseNs/);
  assert.throws(() => transformSelect(index.replace('  select(m) {', '  select(changed) {')),
    /anchor changed/);
  assert.throws(() => transformSelect(index.replace('parseLines(cov)', 'lines(cov)')),
    /source changed/);
});

test('phase profiles reset first-seen state and serialize only counters', () => {
  const first = newProfile();
  first.calls = 2;
  first.seen.add('1-3');
  const second = newProfile();
  assert.equal(second.calls, 0);
  assert.equal(second.seen.size, 0);
  assert.equal(profileData(first).uniqueCoverageStrings, 1);
  assert.equal('seen' in profileData(first), false);
});

test('source pin rejects byte changes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cupel-s19-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.mjs'), 'one\n');
  const frozen = sourceDigest(dir);
  assertSource(dir, frozen);
  writeFileSync(join(dir, 'a.mjs'), 'two\n');
  assert.throws(() => assertSource(dir, frozen), /source tree changed/);
});
