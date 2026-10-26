import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = join(root, 'docs/extending/unittest-example');
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

test('independent docs-only adapter preserves its operation and negative-case smoke tests', () => {
  const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', join(example, 'smoke'), '-q'],
    { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stderr, /Ran 6 tests/);
});

test('independent adapter matches its hand-derived conformance fixture', () => {
  const adapter = `python3 '${join(example, 'adapter.py').replaceAll("'", "'\"'\"'")}'`;
  const run = spawnSync(process.execPath, [join(root, 'packages/cupel/bin/cupel.mjs'),
    'conformance', '--adapter', adapter, '--fixtures', join(example, 'conformance'), '--json'],
    { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.equal(JSON.parse(run.stdout).pass, true);
});
