import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = join(root, 'docs/extending/unittest-example');
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

test('independent docs-only adapter preserves its operation and negative-case smoke tests', () => {
  const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', join(example, 'smoke'), '-q'],
    { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stderr, /Ran 6 tests/);
});

test('independent adapter matches its hand-derived conformance fixture', (t) => {
  const adapter = `python3 '${join(example, 'adapter.py').replaceAll("'", "'\"'\"'")}'`;
  // The fixture was derived on Python 3.14.8; the runtime it reports is whichever python3 runs it, so a copy of
  // the fixtures expects that version and everything else exactly as written.
  const version = spawnSync('python3', ['-c', 'import platform; print(platform.python_version())'], { env, encoding: 'utf8' }).stdout.trim();
  const fixtures = mkdtempSync(join(tmpdir(), 'cupel-unittest-fixtures-'));
  t.after(() => rmSync(fixtures, { recursive: true, force: true }));
  cpSync(join(example, 'conformance'), fixtures, { recursive: true });
  const expectedFile = join(fixtures, 'unittest-basic/expected.json');
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
  assert.equal(expected.runtime.version, '3.14.8');
  expected.runtime.version = version;
  writeFileSync(expectedFile, JSON.stringify(expected, null, 2));
  const run = spawnSync(process.execPath, [join(root, 'packages/cupel/bin/cupel.mjs'),
    'conformance', '--adapter', adapter, '--fixtures', fixtures, '--json'],
    { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message || `exit ${run.status}`);
  assert.equal(JSON.parse(run.stdout).pass, true);
});
