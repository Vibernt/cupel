import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { mutateVitest, confirmSurvivors } from '../src/mutate/index.mjs';
import { projectTypeScript, scanJsx } from '../src/lang/js/project-typescript.mjs';
import { scanSources } from '../src/collect/vitest/sources.mjs';
import { main } from '../src/cli/main.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const versions = [
  ['4.1.11', '/Users/vid/codecrystal/hub-ts/node_modules'],
  ['5.0.1', '/Users/vid/codecrystal/web/node_modules'],
];

function project(modules) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/mutate-vitest-'));
  const files = {
    'package.json': '{"private":true,"type":"module","devDependencies":{"vitest":"*"}}\n',
    'vitest.config.mjs': "export default { define: { __CUPEL_TEST_DEFINE__: 'true' }, test: { testTimeout: 1000 } };\n",
    'src/math.ts': `export function clamp(x: number): number {
  if (x > 10) return 10;
  return x;
}
export function spin(n: number): number {
  let i = 0;
  while (i < n) i += 1;
  return i;
}
`,
    'src/widget.tsx': `interface Props { label: string }
export function helper(x: number): number {
  return x > 2 ? x : 2;
}
export function Widget(props: Props) { return <span>{props.label}</span>; }
`,
    'src/view.jsx': `export function jsHelper(x) { return x > 3 ? x : 3; }
export function View() { return <b>ok</b>; }
`,
    'tests/math.test.ts': `import { test, expect } from 'vitest';
import { clamp, spin } from '../src/math';
test('clamp caps big values', () => { expect(clamp(50)).toBe(10); });
test('clamp touches small values', () => { clamp(3); });
test('spin counts up', () => { expect(spin(3)).toBe(3); });
test('project config is loaded', () => { expect(__CUPEL_TEST_DEFINE__).toBe(true); });
`,
    'tests/widget.test.ts': `import { test, expect } from 'vitest';
import { helper } from '../src/widget';
test('helper high', () => { expect(helper(5)).toBe(5); });
test('helper low unasserted', () => { helper(1); });
`,
    'tests/view.test.ts': `import { test, expect } from 'vitest';
import { jsHelper } from '../src/view';
test('JSX helper', () => { expect(jsHelper(5)).toBe(5); });
`,
    'tests/unrelated.test.ts': `import { test, expect } from 'vitest';
test('unrelated', () => { expect(1).toBe(1); });
`,
    'tests/jsx.test.tsx': `import { test, expect } from 'vitest';
test('TSX test body', () => { expect(<em>ok</em>).toBeTruthy(); });
`,
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(modules, 'vitest'), join(root, 'node_modules/vitest'));
  symlinkSync('/Users/vid/codecrystal/hub-ts/node_modules/typescript', join(root, 'node_modules/typescript'));
  symlinkSync('/Users/vid/codecrystal/web/node_modules/react', join(root, 'node_modules/react'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function hashes(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && (name === '.scratch' || name === '.git' || name === 'node_modules')) continue;
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

test('JSX sources without a project TypeScript package are skipped with one line each', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/no-typescript-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.tsx'), 'export const a = <b>one</b>;');
    writeFileSync(join(root, 'src/b.jsx'), 'export const b = <b>two</b>;');
    const logs = [];
    assert.equal(scanSources(root, {}, (line) => logs.push(line)).size, 0);
    assert.deepEqual(logs, [
      'Vitest: skipped src/a.tsx: typescript is not resolvable from the project root',
      'Vitest: skipped src/b.jsx: typescript is not resolvable from the project root',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a resolved TypeScript package without createScanner reports the incompatibility', { skip: !existsSync('/Users/vid/codecrystal/web/node_modules/typescript/package.json') }, () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/typescript-api-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'src'));
    symlinkSync('/Users/vid/codecrystal/web/node_modules/typescript', join(root, 'node_modules/typescript'));
    writeFileSync(join(root, 'src/a.tsx'), 'export const a = <b>one</b>;');
    const logs = [], diagnostics = [];
    assert.equal(scanSources(root, {}, (line) => logs.push(line), diagnostics).size, 0);
    assert.match(logs[0], /does not expose createScanner and createSourceFile/);
    assert.equal(diagnostics[0].file, 'src/a.tsx');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Vitest collection reports a module load error rather than a partial input', { skip: !existsSync('/Users/vid/codecrystal/hub-ts/node_modules/vitest/package.json') }, async (t) => {
  const p = project('/Users/vid/codecrystal/hub-ts/node_modules');
  t.after(p.cleanup);
  writeFileSync(join(p.root, 'tests/broken.test.ts'), "import '../src/missing';\n");
  await assert.rejects(collectVitest({ root: p.root, files: ['tests/broken.test.ts'], runs: 1 }), (error) => {
    assert.equal(error.exitCode, 3);
    assert.match(error.message, /could not load tests\/broken\.test\.ts: Cannot find module/);
    return true;
  });
});

test('Vitest CLI report and --evidence run mutation', { skip: !existsSync('/Users/vid/codecrystal/hub-ts/node_modules/vitest/package.json'), timeout: 60000 }, async (t) => {
  const p = project('/Users/vid/codecrystal/hub-ts/node_modules');
  t.after(p.cleanup);
  assert.equal(spawnSync('git', ['init', '-q', p.root]).status, 0);
  writeFileSync(join(p.root, 'cupel.json'), JSON.stringify({
    tiers: { critical: ['src/math.ts'] },
    advice: { minRuns: 1 },
    mutation: { maxMutants: 2, maxSeconds: 30, seed: 17 },
  }));
  const before = hashes(p.root);
  let err = '', out = '';
  const exit = await main(['report', '--runs', '1', '--evidence', '--json', '--out', '.scratch/input.json'], {
    cwd: p.root, env: process.env, colour: false, out: (s) => { out += s; }, err: (s) => { err += s; },
  });
  assert.equal(exit, 0, err);
  assert.match(err, /mutating \(critical\)/);
  assert.ok(JSON.parse(readFileSync(join(p.root, '.scratch/input.json'), 'utf8')).mutation.mutants.length);
  assert.equal(JSON.parse(out).kind, 'report');
  assert.deepEqual(hashes(p.root), before);
  t.diagnostic(err.trim());
});

for (const [version, modules] of versions) {
  const available = existsSync(join(modules, 'vitest/package.json')) && existsSync(join(modules, 'typescript/package.json'));
  for (const form of ['inline', 'files']) {
    test(`Vitest ${version}: ${form} project mutation kills a mutant`,
      { skip: !available && `Vitest ${version} or TypeScript unavailable`, timeout: 60000 }, async (t) => {
        const p = project(modules);
        t.after(p.cleanup);
        if (form === 'inline') {
          writeFileSync(join(p.root, 'vitest.config.mjs'), `export default { test: { projects: [
            { test: { name: 'unit', include: ['tests/math.test.ts'] } },
            { test: { name: 'integration', include: ['tests/widget.test.ts'] } },
          ] } };\n`);
        } else {
          writeFileSync(join(p.root, 'vitest.config.mjs'), "export default { test: { projects: ['./vitest.unit.config.mjs', './vitest.integration.config.mjs'] } };\n");
          writeFileSync(join(p.root, 'vitest.unit.config.mjs'), "export default { test: { name: 'unit', include: ['tests/math.test.ts'] } };\n");
          writeFileSync(join(p.root, 'vitest.integration.config.mjs'), "export default { test: { name: 'integration', include: ['tests/widget.test.ts'] } };\n");
        }
        const config = { runners: { vitest: { project: 'unit', tests: 'tests/**/*.test.ts' } },
          mutation: { maxMutants: 10, seed: 17, maxSeconds: 30 } };
        const input = await collectVitest({ root: p.root, config, runs: 1 });
        assert.ok(input.tests.length);
        assert.ok(input.tests.every((row) => row.file === 'tests/math.test.ts'));
        const result = await mutateVitest({ root: p.root, input, config, jobs: 1,
          timeoutFloorMs: 600, collectorKind: 'vitest', scope: { changed: { 'src/math.ts': '2' } } });
        assert.deepEqual(result.mutants.find((row) => row.operator === 'cmp-flip')?.killedBy,
          ['tests/math.test.ts::clamp caps big values']);
      });
  }
  test(`Vitest ${version}: TypeScript, TSX and in-memory mutation`, { skip: !available && `Vitest ${version} or TypeScript unavailable`, timeout: 120000 }, async (t) => {
    const p = project(modules);
    t.after(p.cleanup);
    const before = hashes(p.root);
    const ts = projectTypeScript(p.root);
    assert.ok(ts);
    const source = readFileSync(join(p.root, 'src/widget.tsx'), 'utf8');
    assert.deepEqual(scanJsx(ts, 'src/widget.tsx', source).analysis.coverable, [2, 3, 4, 5]);
    const input = await collectVitest({ root: p.root, runs: 1 });
    assert.equal(input.sources['src/widget.tsx'].coverable, '2-5');
    assert.equal(input.sources['src/view.jsx'].coverable, '1-2');
    assert.ok(input.tests.some((t) => t.id === 'tests/jsx.test.tsx::TSX test body'));
    assert.ok(input.shapes['tests/jsx.test.tsx::TSX test body']?.length);
    assert.ok(!input.sources['src/widget.tsx'].coverable.includes('1'));
    const options = { root: p.root, input, jobs: 1, timeoutFloorMs: 600, collectorKind: 'vitest' };
    const t0 = performance.now();
    const scope = { changed: { 'src/math.ts': '2-3', 'src/widget.tsx': '3' } };
    const config = { mutation: { maxMutants: 10, seed: 17, maxSeconds: 90 } };
    const first = await mutateVitest({ ...options, config, scope });
    const elapsed = performance.now() - t0;
    const second = await mutateVitest({ ...options, config, scope });
    assert.deepEqual(second, first, 'same ids and outcomes for the same input and seed');
    assert.equal(first.sampled, false);
    const find = (source, line, operator) => first.mutants.find((m) => m.source === source && m.line === line && m.operator === operator);
    assert.deepEqual(find('src/math.ts', 2, 'cmp-flip').killedBy, ['tests/math.test.ts::clamp caps big values']);
    assert.equal(find('src/math.ts', 2, 'boundary').status, 'survived');
    assert.deepEqual(find('src/widget.tsx', 3, 'cmp-flip').killedBy, ['tests/widget.test.ts::helper high']);
    const survivor = find('src/widget.tsx', 3, 'boundary');
    assert.equal(survivor.status, 'survived');
    const confirmed = await confirmSurvivors({ ...options, config, mutation: first, ids: [survivor.id] });
    assert.equal(confirmed.mutants.find((m) => m.id === survivor.id).status, 'survived');
    const capped = await mutateVitest({ ...options, config: { mutation: { maxMutants: 2, seed: 17, maxSeconds: 30 } }, scope });
    assert.equal(capped.mutants.length, 2);
    assert.equal(capped.sampled, true);
    const customCommand = await mutateVitest({ ...options,
      config: { runners: { vitest: { command: `"${process.execPath}" "${join(modules, 'vitest/vitest.mjs')}"` } },
        mutation: { maxMutants: 1, seed: 17, maxSeconds: 30 } },
      scope: { changed: { 'src/math.ts': '2' } } });
    assert.equal(customCommand.mutants.length, 1);
    const configFile = join(p.root, 'vitest.config.mjs');
    const savedConfig = readFileSync(configFile, 'utf8');
    rmSync(configFile);
    try {
      const noConfig = await mutateVitest({ ...options,
        config: { mutation: { maxMutants: 1, seed: 17, maxSeconds: 30 } },
        scope: { changed: { 'src/math.ts': '2' } } });
      assert.equal(noConfig.mutants.length, 1);
    } finally { writeFileSync(configFile, savedConfig); }
    const jsx = await mutateVitest({ ...options, config, scope: { changed: { 'src/view.jsx': '1' } } });
    assert.deepEqual(jsx.mutants.find((m) => m.operator === 'cmp-flip').killedBy, ['tests/view.test.ts::JSX helper']);
    assert.equal(jsx.mutants.find((m) => m.operator === 'boundary').status, 'survived');
    const timeout = await mutateVitest({ ...options, config, scope: { changed: { 'src/math.ts': '7' } } });
    assert.equal(timeout.mutants.find((m) => m.operator === 'arith').status, 'timeout');
    const unrelated = 'tests/unrelated.test.ts::unrelated';
    const falseCoverage = {
      ...input,
      coverage: {
        ...input.coverage,
        byTest: Object.fromEntries(Object.entries(input.coverage.byTest).map(([id, lines]) => [id,
          id === unrelated ? { 'src/widget.tsx': '3' } : Object.fromEntries(Object.entries(lines).filter(([file]) => file !== 'src/widget.tsx'))])),
        setup: Object.fromEntries(Object.entries(input.coverage.setup).map(([file, lines]) => [file,
          Object.fromEntries(Object.entries(lines).filter(([source]) => source !== 'src/widget.tsx'))])),
      },
    };
    const notLoaded = await mutateVitest({ ...options, input: falseCoverage,
      config: { mutation: { maxMutants: 1, seed: 17, maxSeconds: 30 } }, scope: { changed: { 'src/widget.tsx': '3' } } });
    assert.equal(notLoaded.mutants[0].status, 'error', 'a selected test that never loads the source cannot make a survivor');
    assert.deepEqual(hashes(p.root), before, 'every project-owned file retains its original hash');
    t.diagnostic(`${version}: ${first.mutants.length} mutants in ${Math.round(elapsed)} ms (${(first.mutants.length * 60000 / elapsed).toFixed(1)}/minute)`);
  });
}
