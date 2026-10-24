import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from './generate.mjs';

test('S11 generator reproduces 30 packages and 1000 tests with the requested shapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s11-'));
  try {
    generate(root);
    const packages = readdirSync(root).filter((name) => name.startsWith('p'));
    assert.equal(packages.length, 30);
    const files = packages.flatMap((pkg) => readdirSync(join(root, pkg)).map((name) => join(root, pkg, name)));
    const texts = files.map((file) => readFileSync(file, 'utf8'));
    const all = texts.join('\n');
    assert.equal([...all.matchAll(/func Test(?:External|Work)\d+\(/g)].length, 1000);
    assert.equal([...all.matchAll(/func TestMain\(/g)].length, 1);
    assert.equal([...all.matchAll(/t\.Parallel\(\)/g)].length, 3);
    assert.equal([...all.matchAll(/func init\(/g)].length, 5);
    assert.equal([...all.matchAll(/package p\d+_test/g)].length, 30);
    assert.ok(all.includes('t.Run("child"'));
    assert.ok(all.includes('return p28.Work0(v)'));
    generate(root);
    assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), texts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
