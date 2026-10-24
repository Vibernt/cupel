import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profile, covered, subtract } from '../src/collect/go/coverage.mjs';

test('Go block cache preserves zero blocks, changing counts, UTF-8 columns and setup subtraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-go-profile-'));
  try {
    writeFileSync(join(root, 'code.go'), 'package sample\nfunc F() { /* é */ println("é") }\n');
    const pkgs = [{ ImportPath: 'example.com/sample', Dir: root }];
    const file = join(root, 'profile'); const cache = new Map();
    const read = (count, targetCache = cache) => {
      writeFileSync(file, `mode: count\nexample.com/sample/code.go:2.21,2.33 1 ${count}\n`);
      return profile(file, pkgs, root, targetCache);
    };
    const setup = read(2);
    assert.deepEqual(covered(setup), { 'code.go': '2' });
    const zero = read(0);
    assert.deepEqual(covered(zero), {});
    assert.deepEqual([...zero.get('code.go').all], [2]);
    assert.deepEqual(subtract(read(2), setup), {});
    assert.deepEqual(subtract(read(3), setup), { 'code.go': '2' });
    assert.deepEqual(read(3), read(3, new Map()));
    assert.equal([...read(8).get('code.go').blocks.values()][0].touched, [...setup.get('code.go').blocks.values()][0].touched);
    writeFileSync(file, 'mode: count\nexample.com/sample/code.go:2.21,2.33 1 bad\n');
    assert.throws(() => profile(file, pkgs, root, cache), /bad Go coverprofile row/);
    writeFileSync(file, 'mode: atomic\n');
    assert.throws(() => profile(file, pkgs, root, cache), /not mode: count/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Go coverage caches are scoped to a collection and still reject unknown packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-go-profile-'));
  try {
    const file = join(root, 'profile');
    writeFileSync(file, 'mode: count\nunknown/code.go:1.1,1.2 1 0\n');
    assert.throws(() => profile(file, [], root, new Map()), /no local package/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
