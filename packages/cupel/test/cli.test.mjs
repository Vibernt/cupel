import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT, SPEC_VERSION } from '../src/index.mjs';

const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('spec version is cupel-spec/1', () => {
  assert.equal(SPEC_VERSION, 'cupel-spec/1');
});

test('exit codes are stable', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, FAILED: 1, USAGE: 2, ENVIRONMENT: 3 });
});

test('--help prints usage and exits 0', () => {
  const r = run('--help');
  assert.equal(r.status, EXIT.OK);
  assert.match(r.stdout, /Usage: cupel <command>/);
});

test('no arguments prints usage and exits 2', () => {
  assert.equal(run().status, EXIT.USAGE);
});

test('--version prints the package version', () => {
  const r = run('--version');
  assert.equal(r.status, EXIT.OK);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('unknown command exits 2', () => {
  const r = run('frobnicate');
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stderr, /unknown command/);
});
