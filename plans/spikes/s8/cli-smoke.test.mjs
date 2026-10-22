import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { run } from './lib.mjs';

const cupel = resolve(fileURLToPath(new URL('../../../packages/cupel/bin/cupel.mjs', import.meta.url)));

test('the S8 retrospective check command collects the specified flat test glob and writes input', () => {
  const dir = mkdtempSync(join(tmpdir(), 's8-cli-smoke-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(dir, 'src/value.mjs'), 'export const value = () => 1;\n');
    writeFileSync(join(dir, 'tests/a.test.mjs'), "import test from 'node:test';\nimport { strict as assert } from 'node:assert';\nimport { value } from '../src/value.mjs';\ntest('new case', () => assert.equal(value(), 1));\n");
    writeFileSync(join(dir, 'cupel.json'), '{"runners":{"node":{"tests":"tests/*.test.mjs"}}}\n');
    const inputPath = join(dir, 'input.json');
    const result = run(process.execPath, [cupel, 'check', 'tests/a.test.mjs::new case', '--no-mutation', '--runs', '1', '--json', '--out', inputPath, '--quiet'], { cwd: dir });
    assert.ok([0, 1].includes(result.status), result.stderr);
    assert.equal(JSON.parse(result.stdout).check.verdicts.length, 1);
    assert.ok(JSON.parse(readFileSync(inputPath, 'utf8')).tests.some((t) => t.id === 'tests/a.test.mjs::new case'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
