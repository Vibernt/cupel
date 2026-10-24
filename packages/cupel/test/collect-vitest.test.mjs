import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { match } from '../src/conformance/match.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';
import { main } from '../src/cli/main.mjs';
import { requireCollector } from '../src/cli/collect.mjs';
import { linkVitestModules } from './vitest-modules.mjs';
import { VitestMutantRunner } from '../src/mutate/vitest.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repo, 'spec/conformance/adapters/vitest');
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((name) => [name,
  JSON.parse(readFileSync(join(repo, `spec/schemas/${name}.schema.json`), 'utf8'))]));
const versions = [
  ['4.1.11', '/Users/vid/codecrystal/hub-ts/node_modules'],
  ['5.0.1', '/Users/vid/codecrystal/web/node_modules'],
];

test('Vitest K10 title survives shifted lines and K13 records a changing branch', { skip: !existsSync(join(versions[0][1], 'vitest/package.json')) }, async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/vitest-k10-k13-'));
  try {
    cpSync(fixture, root, { recursive: true });
    linkVitestModules(root, versions[0][1]);
    mkdirSync(join(root, '.scratch'), { recursive: true });
    writeFileSync(join(root, '.scratch/count'), '0');
    writeFileSync(join(root, 'src/branch.ts'), 'export function pick(n: number) {\n  if (n % 2) {\n    return 1\n  }\n  return 2\n}\n');
    const body = "import { test, expect } from 'vitest';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport { pick } from '../src/branch';\nconst counter = new URL('../.scratch/count', import.meta.url);\nconst n = Number(readFileSync(counter, 'utf8'));\nwriteFileSync(counter, String(n + 1));\ntest.each([1, 2])('pick %i', () => expect(pick(n)).toBe(n % 2 ? 1 : 2));\ntest.each([3, 4])('pick %i', () => expect(pick(n)).toBe(n % 2 ? 1 : 2));\n";
    const file = join(root, 'tests/branch.test.ts');
    writeFileSync(file, body);
    const first = await collectVitest({ root, files: ['tests/branch.test.ts'], runs: 3 });
    assert.deepEqual(new Set(first.tests.map((row) => row.unit)), new Set(['tests/branch.test.ts::pick %i', 'tests/branch.test.ts::pick %i #2']));
    assert.match(first.coverage.unstable['src/branch.ts'], /3/);
    assert.match(first.coverage.unstable['src/branch.ts'], /5/);
    writeFileSync(file, `\n\n\n${body}`);
    writeFileSync(join(root, '.scratch/count'), '0');
    const shifted = await collectVitest({ root, files: ['tests/branch.test.ts'], runs: 3 });
    assert.deepEqual(shifted.tests.map((row) => row.unit), first.tests.map((row) => row.unit));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI selects a Vite test config and keeps node:test as the plain Node default', async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/vitest-detect-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}');
    assert.equal((await requireCollector(process.env, root, {})).kind, undefined);
    writeFileSync(join(root, 'vite.config.mjs'), 'export default { test: { globals: true } }');
    assert.equal((await requireCollector(process.env, root, {})).kind, 'vitest');
    rmSync(join(root, 'vite.config.mjs'));
    writeFileSync(join(root, 'package.json'), '{"type":"module","private":true,"devDependencies":{"vitest":"5.0.1"}}');
    assert.equal((await requireCollector(process.env, root, {})).kind, 'vitest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [version, modules] of versions) {
  test(`Vitest ${version}: fixture, schema, report, and recheck`, { skip: !existsSync(join(modules, 'vitest/package.json')) && `Vitest ${version} is not resolvable` }, async () => {
    mkdirSync(join(repo, '.scratch'), { recursive: true });
    const root = mkdtempSync(join(repo, '.scratch/vitest-test-'));
    try {
      cpSync(fixture, root, { recursive: true });
      linkVitestModules(root, modules);
      const input = await collectVitest({ root, runs: 2 });
      assert.deepEqual(match(expected, input), []);
      assert.deepEqual(validate(schemas.input, input), []);
      assert.equal(run('report', { input }, {}, {}, schemas).exit, 0);
      assert.equal(input.tests.length, 4);
      for (const t of input.tests) assert.equal(t.durationsMs.length, 2);
      assert.equal(input.sources['src/math.ts'].hash, `sha256:${createHash('sha256').update(readFileSync(join(root, 'src/math.ts'))).digest('hex')}`);
      assert.equal(input.sources['src/math.ts'].coverable, '7-9,11-15');
      assert.ok(input.shapes['tests/math.test.ts::cap > maps %i to %i']?.length > 0);
      const unit = 'tests/math.test.ts::cap > maps %i to %i';
      const rechecked = await collectVitest({ root, runs: 1, recheck: [unit] });
      assert.deepEqual(rechecked.coverage.rechecked, [unit]);
      assert.deepEqual(match(expected, rechecked), []);
      const commanded = await collectVitest({ root, runs: 1, config: { runners: { vitest: { command: `"${process.execPath}" "${join(root, 'node_modules/vitest/vitest.mjs')}"`, tests: 'tests/**/*.test.ts' } } } });
      assert.deepEqual(match(expected, commanded), []);
      assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
      let out = '', err = '';
      const exit = await main(['report', '--runs', '1', '--json'], {
        cwd: root, env: process.env, colour: false,
        out: (text) => { out += text; }, err: (text) => { err += text; },
      });
      assert.equal(exit, 0, err);
      assert.equal(JSON.parse(out).kind, 'report');
      assert.match(err, /mutating \(critical\)/);
      writeFileSync(join(root, 'tests/spawn.test.ts'), "import { spawnSync } from 'node:child_process'\ntest('starts node', () => { spawnSync(process.execPath, ['-e', '']) })\n");
      const spawned = await collectVitest({ root, files: ['tests/spawn.test.ts'], runs: 1 });
      assert.equal(spawned.tests[0].spawnsInterpreter, true);
      writeFileSync(join(root, 'tests/custom.unit.ts'), "test('custom selection', () => { expect(1).toBe(1) })\n");
      const custom = await collectVitest({ root, config: { runners: { vitest: { tests: 'tests/**/*.unit.ts' } } }, runs: 1 });
      assert.deepEqual(custom.tests.map((t) => t.id), ['tests/custom.unit.ts::custom selection']);
      writeFileSync(join(root, 'vitest.config.ts'), `import path from 'node:path';
export default { resolve: { alias: { '@source': path.resolve(__dirname, 'src') } },
  test: { globals: true, include: ['tests/alias.test.ts'] } };
`);
      rmSync(join(root, 'vitest.config.mjs'));
      writeFileSync(join(root, 'tests/alias.test.ts'), "import { add } from '@source/math';\ntest('dirname alias', () => { expect(add({ left: 1, right: 2 })).toBe(3); });\n");
      const dirnameInput = await collectVitest({ root, runs: 1 });
      assert.deepEqual(dirnameInput.tests.map((t) => t.id), ['tests/alias.test.ts::dirname alias']);
      assert.equal(dirnameInput.tests[0].status, 'passed');
      const mutationWork = mkdtempSync(join(root, '.scratch/vitest-mutation-config-'));
      const mutationRunner = new VitestMutantRunner(root, {}, mutationWork);
      const mutationResult = await mutationRunner.runTestFile({ file: 'tests/alias.test.ts', timeoutMs: 10000 });
      assert.equal(mutationResult.code, 0, mutationResult.stderr);
      assert.ok(mutationResult.results.some((row) => row.t?.includes('dirname alias')));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
