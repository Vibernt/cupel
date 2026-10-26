import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './command.mjs';

test('command records failure without replacing it with a passing path', () => {
  const output = mkdtempSync(join(tmpdir(), 'cupel-acceptance-command-'));
  try {
    const result = command(output, 'failure', process.execPath,
      ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7']);
    assert.equal(result.exit, 7);
    assert.equal(readFileSync(result.stdout,'utf8'),'out');
    assert.equal(readFileSync(result.stderr,'utf8'),'err');
    assert.ok(result.wallMs >= 0);
    assert.equal(JSON.parse(readFileSync(join(output,'failure.command.json'),'utf8')).exit, 7);
  } finally { rmSync(output, { recursive:true }); }
});
