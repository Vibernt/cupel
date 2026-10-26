import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inputAt, parseJson, reportOptions } from './stage-input.mjs';

test('stage input requires a fresh populated collector file with the expected runtime', () => {
  const dir = mkdtempSync('/tmp/cupel-input-');
  const path = join(dir, 'input.json');
  const repo = { dir, runner: 'pytest' };
  try {
    assert.throws(() => inputAt(repo, path), /missing/);
    writeFileSync(path, JSON.stringify({ runtime: { name: 'python' }, tests: [] }));
    assert.throws(() => inputAt(repo, path), /zero tests/);
    writeFileSync(path, JSON.stringify({ runtime: { name: 'node' }, tests: [{ id: 'a' }] }));
    assert.throws(() => inputAt(repo, path), /expected a python runtime/);
    writeFileSync(path, JSON.stringify({ runtime: { name: 'python' }, tests: [{ id: 'a' }] }));
    assert.equal(inputAt(repo, path).tests.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('report options and JSON failures retain explicit reasons', () => {
  assert.match(reportOptions('/work/out.json', false), /--no-mutation/);
  assert.throws(() => parseJson({ stdout: 'bad', stderr: 'collector crashed', exitCode: 3 }, 'report'), /collector crashed/);
});
