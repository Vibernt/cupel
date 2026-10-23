import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../src/collect/node/index.mjs';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { analyseAssertions } from '../src/analysis/assertions.mjs';
import { main } from '../src/cli/main.mjs';
import { linkVitestModules } from './vitest-modules.mjs';
const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
function snapshot(root, dir = '') {
  return readdirSync(join(root, dir)).filter((f) => f !== '.scratch' && f !== 'node_modules').sort().flatMap((f) => {
    const rel = join(dir, f), path = join(root, rel);
    return lstatSync(path).isDirectory() ? snapshot(root, rel) : [[rel, readFileSync(path, 'utf8')]];
  });
}
for (const framework of ['node', 'vitest']) test(`${framework}: assertion repeats, boundary, empty, clone, recording determinism and read-only source`, async () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, `assertions-${framework}-`));
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, ...(framework === 'vitest' ? { devDependencies: { vitest: '4.1.11' } } : {}) }));
    if (framework === 'vitest') linkVitestModules(root, '/Users/vid/codecrystal/hub-ts/node_modules');
    const check = framework === 'node' ? 'assert.strictEqual(result, 10)' : 'expect(result).toBe(10)';
    const source = `${framework === 'node' ? "import { test } from 'node:test'; import assert from 'node:assert';" : "import { test, expect } from 'vitest';"}
const identity = (x) => x;
test('base', () => { const result = identity(10); ${check}; });
test('repeat', () => { const result = identity(10); ${check}; ${check}; });
test('boundary', () => { const result = identity(11); ${check.replace('10', '11')}; });
test('empty', () => { identity(10); });
test('clone', () => { const result = identity(10); ${check}; });
test('trivial', () => { const value = 1; ${framework === 'node' ? 'assert.ok(true);' : 'expect(value).toBeDefined(); expect(value).toBe(value);'} });
`;
    writeFileSync(join(root, 'tests/example.test.mjs'), source);
    const before = snapshot(root);
    const out = join(root, '.scratch/input.json');
    const collect = framework === 'node' ? collectNode : collectVitest;
    const input = await collect({ root, runs: 1, assertionsOut: `${out}.assertions.json` });
    const side = JSON.parse(readFileSync(`${out}.assertions.json`, 'utf8'));
    assert.ok(input.tests.every((t) => t.status === 'passed'), JSON.stringify(input.tests));
    assert.equal(Object.hasOwn(input, 'assertions'), false);
    const report = analyseAssertions(input, side);
    const unit = (name) => report.units.find((u) => u.id.endsWith(`::${name}`));
    assert.equal(unit('base').assertionCount, 1, JSON.stringify(side));
    assert.equal(unit('repeat').assertionCount, 2);
    assert.ok(unit('base').subsumedBy.includes(unit('repeat').id));
    assert.deepEqual(unit('boundary').subsumedBy, []);
    assert.equal(unit('boundary').uniqueFingerprints.length, 1);
    assert.equal(unit('empty').assertionFree, true);
    assert.equal(unit('trivial').assertionFree, true, JSON.stringify(unit('trivial')));
    assert.ok(unit('base').cloneOf.includes(unit('clone').id));
    const a = unit('base').records[0];
    assert.equal(a.subject, 'result', JSON.stringify(a));
    assert.equal(a.site.file, 'tests/example.test.mjs'); assert.equal(a.site.line, 3);
    const again = await collect({ root, runs: 1, assertionsOut: `${out}.assertions.json` });
    assert.deepEqual(JSON.parse(readFileSync(`${out}.assertions.json`, 'utf8')), side);
    assert.deepEqual(snapshot(root), before);
    writeFileSync(out, JSON.stringify(again));
    let stdout = '', stderr = '';
    const io = { cwd: root, env: process.env, out: (s) => { stdout += s; }, err: (s) => { stderr += s; }, colour: false };
    assert.equal(await main(['assertions', '--input', out, '--json'], io), 0, stderr);
    assert.deepEqual(JSON.parse(stdout), report);
    stdout = ''; stderr = '';
    assert.equal(await main(['assertions', '--input', out], io), 0, stderr);
    assert.match(stdout, /subsumed by:/); assert.match(stdout, /expected=/); assert.match(stdout, /assertion-free/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
