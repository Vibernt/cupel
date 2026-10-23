import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../src/collect/node/index.mjs';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { analyseAssertions } from '../src/analysis/assertions.mjs';
import { main } from '../src/cli/main.mjs';
const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
async function project(framework, source, check, options = {}) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, `assertions-${framework}-`));
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, ...(framework === 'vitest' ? { devDependencies: { vitest: '4.1.11' } } : {}) }));
    if (framework === 'vitest') symlinkSync('/Users/vid/codecrystal/hub-ts/node_modules', join(root, 'node_modules'));
    const { testFile = 'tests/example.test.mjs', ...collectionOptions } = options;
    writeFileSync(join(root, testFile), source);
    const out = join(root, '.scratch/input.json');
    const input = await (framework === 'node' ? collectNode : collectVitest)({ root, runs: 1, assertionsOut: `${out}.assertions.json`, ...collectionOptions });
    const sidecar = JSON.parse(readFileSync(`${out}.assertions.json`, 'utf8'));
    await check({ root, out, input, sidecar, report: analyseAssertions(input, sidecar) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('node: callable defaults, ESM named exports, CommonJS, negatives, async, Assert and caught failures', async () => {
  await project('node', `import { test } from 'node:test';
import assert, { strictEqual } from 'node:assert';
import strict, { equal } from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cjs = require('assert'); const cs = require('assert/strict');
test('apis', async () => {
  assert(true); strict(true); cjs(true); cs(true); strictEqual(1, 1); equal(1, 1);
  assert.equal('1', 1); assert.notEqual(1, 2); assert.notStrictEqual(1, '1');
  assert.deepEqual({ a: 1 }, { a: '1' }); assert.deepStrictEqual({ b: 2 }, { b: 2 });
  assert.notDeepEqual({ a: 1 }, { a: 2 }); assert.notDeepStrictEqual([1], ['1']);
  assert.match('yes', /yes/); assert.doesNotMatch('yes', /no/);
  assert.throws(() => { throw new Error('bad'); }, /bad/); assert.doesNotThrow(() => 1);
  await assert.rejects(Promise.reject(new Error('bad')), /bad/); await assert.doesNotReject(Promise.resolve(1));
  assert.ifError(null);
  try { assert.fail('intentional'); } catch (error) { if (error.code !== 'ERR_ASSERTION') throw error; }
  if (assert.partialDeepStrictEqual) assert.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 });
  if (assert.Assert) new assert.Assert().strictEqual(1, 1);
});
test('meaningful ok', () => { const valid = true; assert.ok(valid); });
test('failed', () => assert.strictEqual(1, 2));
test.skip('skipped', () => assert.ok(false));
`, ({ input, report }) => {
    const api = report.units.find((u) => u.id.endsWith('::apis'));
    assert.equal(api.assertionCount, 23);
    assert.equal(api.incomplete, false, JSON.stringify(api));
    for (const name of ['ok', 'strictEqual', 'equal', 'notEqual', 'deepEqual', 'deepStrictEqual', 'notDeepEqual', 'notDeepStrictEqual', 'match', 'doesNotMatch', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'ifError', 'fail']) assert.ok(api.records.some((a) => a.matcher === name), name);
    assert.ok(api.records.every((a) => a.site?.file === 'tests/example.test.mjs'));
    assert.equal(report.units.find((u) => u.id.endsWith('::meaningful ok')).assertionFree, false);
    assert.equal(report.units.find((u) => u.id.endsWith('::failed')).assertionCount, 1);
    assert.equal(report.units.find((u) => u.id.endsWith('::failed')).assertionFree, null);
    assert.equal(report.units.find((u) => u.id.endsWith('::skipped')).assertionFree, null);
    assert.equal(input.tests.find((t) => t.name === 'failed').status, 'failed');
  });
});

test('vitest: negation, async matchers, custom matchers and caught failure preserve execution', async () => {
  await project('vitest', `import { test, expect } from 'vitest';
expect.extend({ toBeEven(received) { return { pass: received % 2 === 0, message: () => 'even' }; } });
test('apis', async () => {
  const actual = { a: 1 };
  expect(actual).toEqual({ a: 1 }); expect(actual).not.toEqual({ a: 2 });
  expect(() => { throw new Error('bad'); }).toThrow(/bad/);
  await expect(Promise.resolve(3)).resolves.toBe(3);
  await expect(Promise.reject(new Error('bad'))).rejects.toThrow(/bad/);
  expect(2).toBeEven();
  try { expect(1).toBe(2); } catch (error) { if (!error.message) throw error; }
});
test('not defined', () => { expect(undefined).not.toBeDefined(); });
`, ({ input, report }) => {
    assert.ok(input.tests.every((t) => t.status === 'passed'), JSON.stringify(input.tests));
    const api = report.units.find((u) => u.id.endsWith('::apis'));
    assert.equal(api.assertionCount, 7, JSON.stringify(api));
    assert.equal(api.incomplete, false);
    assert.deepEqual(api.records.map((a) => a.matcher), ['toEqual', 'not.toEqual', 'toThrow', 'resolves.toBe', 'rejects.toThrow', 'toBeEven', 'toBe']);
    assert.equal(report.units.find((u) => u.id.endsWith('::not defined')).assertionFree, false);
  });
});

for (const framework of ['node', 'vitest']) test(`${framework}: live CLI, cap, missing/stale sidecar`, async () => {
  const source = framework === 'node' ? `import { test } from 'node:test'; import assert from 'node:assert';
test('capped', () => { for (let i = 0; i < 5; i++) assert.equal(i, i); });` : `import { test, expect } from 'vitest';
test('capped', () => { for (let i = 0; i < 5; i++) expect(i).toBe(i); });`;
  await project(framework, source, async ({ root, out, input, report }) => {
    assert.equal(report.units[0].assertionCount, 5); assert.equal(report.units[0].records.length, 2);
    assert.equal(report.units[0].capHit, true); assert.equal(report.units[0].assertionFree, null);
    let stdout = '', stderr = '';
    const io = { cwd: root, env: process.env, out: (s) => { stdout += s; }, err: (s) => { stderr += s; }, colour: false };
    // Anchor git root discovery inside the isolated synthetic project.
    const { spawnSync } = await import('node:child_process');
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    assert.equal(await main(['assertions', '--out', out, '--json'], io), 0, stderr);
    assert.equal(JSON.parse(stdout).units[0].assertionCount, 5);
    writeFileSync(out, JSON.stringify({ ...input, tests: [] })); stdout = ''; stderr = '';
    assert.equal(await main(['assertions', '--input', out, '--json'], io), 2);
    assert.match(stderr, /does not match/);
    rmSync(`${out}.assertions.json`); stderr = '';
    assert.equal(await main(['assertions', '--input', out], io), 2);
    assert.match(stderr, /cannot read assertion sidecar/);
  }, { assertionCap: 2 });
});

test('vitest: TypeScript source locations and multiline subjects', async () => {
  await project('vitest', `import { test, expect } from 'vitest';
test('typescript', () => {
  const result: { count: number } = { count: 2 };
  expect(
    result /* preserve expression, remove comment */ . count
  ).toBe(2);
});
`, ({ report }) => {
    const a = report.units[0].records[0];
    assert.equal(a.subject, 'result . count', JSON.stringify(a));
    assert.equal(a.site.file, 'tests/example.test.ts');
    assert.equal(a.site.line, 6);
    assert.equal(a.matcher, 'toBe');
  }, { testFile: 'tests/example.test.ts' });
});

for (const framework of ['node', 'vitest']) test(`${framework}: concurrent assertions are marked incomplete instead of claimed unique`, async () => {
  const source = framework === 'node' ? `import { test } from 'node:test'; import assert from 'node:assert';
test('parent', { concurrency: true }, async (t) => {
  await Promise.all([t.test('a', { concurrency: true }, async () => { await new Promise(r => setTimeout(r, 20)); assert.equal(1, 1); }),
    t.test('b', { concurrency: true }, async () => { await new Promise(r => setTimeout(r, 40)); assert.equal(2, 2); })]);
});` : `import { test, expect } from 'vitest';
test.concurrent('a', async () => { await new Promise(r => setTimeout(r, 20)); expect(1).toBe(1); });
test.concurrent('b', async () => { await new Promise(r => setTimeout(r, 40)); expect(2).toBe(2); });`;
  await project(framework, source, ({ report }) => {
    const ambiguous = report.units.filter((u) => u.errors.includes('concurrent attribution is ambiguous'));
    assert.ok(ambiguous.length > 0, JSON.stringify(report));
    for (const u of ambiguous) { assert.equal(u.assertionFree, null); assert.deepEqual(u.subsumedBy, []); }
  });
});

for (const framework of ['node', 'vitest']) test(`${framework}: assertions inside throw callbacks are recorded too`, async () => {
  const source = framework === 'node' ? `import { test } from 'node:test'; import assert from 'node:assert';
test('nested', () => { assert.throws(() => { assert.equal(1, 2); }, /1 == 2/); });` : `import { test, expect } from 'vitest';
test('nested', () => { expect(() => { expect(1).toBe(2); }).toThrow(); });`;
  await project(framework, source, ({ report, input }) => {
    assert.equal(input.tests[0].status, 'passed');
    assert.equal(report.units[0].assertionCount, 2);
  });
});
