// Reproducible S10b recording overhead: identical coverage collector, toggle sidecar only.
// Run from the repository root: node bench/s10b-assertions.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../packages/cupel/src/collect/node/index.mjs';
import { collectVitest } from '../packages/cupel/src/collect/vitest/index.mjs';
const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, 's10b-benchmark-'));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const snapshot = (root) => {
  const visit = (dir) => readdirSync(dir).filter((n) => n !== '.scratch' && n !== 'node_modules').sort().flatMap((n) => {
    const p = join(dir, n); return lstatSync(p).isDirectory() ? visit(p) : [[p, readFileSync(p, 'utf8')]];
  });
  return visit(root);
};
const results = { node: process.version, tests: 200, assertionsPerTest: 5, warmupPairs: 1, measuredPairs: 5, suites: {} };
for (const framework of ['node', 'vitest']) {
  const root = join(work, framework);
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  if (framework === 'vitest') symlinkSync('/Users/vid/codecrystal/hub-ts/node_modules', join(root, 'node_modules'));
  let source = framework === 'node' ? "import { test } from 'node:test'; import assert from 'node:assert/strict';\n" : "import { test, expect } from 'vitest';\n";
  source += 'const double = (value) => value * 2;\n';
  for (let i = 0; i < 200; i++) {
    const checks = framework === 'node' ? `assert.strictEqual(result, ${i * 2});
  assert.deepStrictEqual({ result }, { result: ${i * 2} });
  assert.match(String(result), /^${i * 2}$/);
  assert.notEqual(result, -1);
  assert.throws(() => { throw new Error('boundary'); }, /boundary/);` : `expect(result).toBe(${i * 2});
  expect({ result }).toEqual({ result: ${i * 2} });
  expect(String(result)).toMatch(/^${i * 2}$/);
  expect(result).not.toBe(-1);
  expect(() => { throw new Error('boundary'); }).toThrow(/boundary/);`;
    source += `test('case ${i}', () => {\n  const result = double(${i});\n  ${checks}\n});\n`;
  }
  writeFileSync(join(root, 'tests/synthetic.test.mjs'), source);
  const before = snapshot(root);
  const collect = framework === 'node' ? collectNode : collectVitest;
  const assertionsOut = join(root, '.scratch/input.json.assertions.json');
  const offMs = [], onMs = [];
  let sidecarBytes;
  for (let pair = -1; pair < 5; pair++) for (const on of pair % 2 === 0 ? [true, false] : [false, true]) {
    const start = performance.now();
    const input = await collect({ root, runs: 1, ...(on ? { assertionsOut } : {}) });
    const elapsed = performance.now() - start;
    assert.equal(input.tests.length, 200);
    assert.ok(input.tests.every((t) => t.status === 'passed'));
    if (on) {
      const sidecar = JSON.parse(readFileSync(assertionsOut, 'utf8'));
      assert.equal(Object.keys(sidecar.tests).length, 200);
      assert.ok(Object.values(sidecar.tests).every((t) => t.count === 5 && !t.incomplete && !t.capHit));
      sidecarBytes = statSync(assertionsOut).size;
    }
    assert.deepEqual(snapshot(root), before);
    if (pair >= 0) (on ? onMs : offMs).push(elapsed);
  }
  const baseline = median(offMs), recording = median(onMs);
  results.suites[framework] = { offMs, onMs, medianOffMs: baseline, medianOnMs: recording,
    deltaMs: recording - baseline, ratio: recording / baseline, overheadPercent: (recording / baseline - 1) * 100, sidecarBytes };
}
const out = join(scratch, 's10b-benchmark.json');
writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
process.stdout.write(JSON.stringify({ out, work, ...results }, null, 2) + '\n');
