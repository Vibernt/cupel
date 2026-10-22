import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { match } from '../src/conformance/match.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';
import { main } from '../src/cli/main.mjs';
import { requireCollector } from '../src/cli/collect.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repo, 'spec/conformance/adapters/vitest');
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((name) => [name,
  JSON.parse(readFileSync(join(repo, `spec/schemas/${name}.schema.json`), 'utf8'))]));
const versions = [
  ['4.1.11', '/Users/vid/codecrystal/hub-ts/node_modules'],
  ['5.0.1', '/Users/vid/codecrystal/web/node_modules'],
];

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
      symlinkSync(modules, join(root, 'node_modules'));
      const input = await collectVitest({ root, runs: 2 });
      assert.deepEqual(match(expected, input), []);
      assert.deepEqual(validate(schemas.input, input), []);
      assert.equal(run('report', { input }, {}, {}, schemas).exit, 0);
      assert.equal(input.tests.length, 4);
      for (const t of input.tests) assert.equal(t.durationsMs.length, 2);
      assert.equal(input.sources['src/math.ts'].hash, `sha256:${createHash('sha256').update(readFileSync(join(root, 'src/math.ts'))).digest('hex')}`);
      assert.equal(input.sources['src/math.ts'].coverable, '7-9,11-15');
      assert.ok(input.shapes['tests/math.test.ts::@13']?.length > 0);
      const unit = 'tests/math.test.ts::@13';
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
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
