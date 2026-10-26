import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceHeavyFixture } from './fixtures.mjs';

test('source-heavy synthetic project executes its full three-test oracle', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s17-fixture-'));
  try {
    const fixture = sourceHeavyFixture(root, 100);
    assert.equal(fixture.input.tests.length, 3);
    assert.equal(fixture.metadata.sourceLines, 103);
    assert.match(readFileSync(join(root, 'src/lookup.mjs'), 'utf8'), /if \(x === 99\) return 100/);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/lookup.test.mjs'],
      { cwd: root, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /# pass 3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('synthetic source size is bounded', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s17-size-'));
  try { assert.throws(() => sourceHeavyFixture(root, 2001), /invalid source-heavy size/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
