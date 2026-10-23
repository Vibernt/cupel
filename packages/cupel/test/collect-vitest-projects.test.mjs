import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { injectVitestProjects } from '../src/collect/vitest/projects.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const versions = [
  ['4.1.11', '/Users/vid/codecrystal/hub-ts/node_modules'],
  ['5.0.1', '/Users/vid/codecrystal/web/node_modules'],
];

function fixture(modules, form) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/vitest-projects-'));
  const files = {
    'package.json': '{"private":true,"type":"module"}',
    'src/score.ts': 'export function score(n: number) { return n > 0 ? 1 : 0; }\n',
    'tests/owner-setup.ts': 'globalThis.__ownerSetup = true;\n',
    'tests/unit.test.ts': "import { test, expect } from 'vitest';\nimport { score } from '../src/score';\ntest('unit positive', () => { expect(globalThis.__ownerSetup).toBe(true); expect(score(2)).toBe(1); });\n",
    'tests/integration.test.ts': "import { test, expect } from 'vitest';\nimport { score } from '../src/score';\ntest('integration zero', () => { expect(globalThis.__ownerSetup).toBe(true); expect(score(0)).toBe(0); });\n",
  };
  if (form === 'inline') {
    files['vitest.config.mjs'] = `export default { test: { projects: [
      { test: { name: 'unit', include: ['tests/unit.test.ts'], setupFiles: ['tests/owner-setup.ts'] } },
      { test: { name: 'integration', include: ['tests/integration.test.ts'], setupFiles: ['tests/owner-setup.ts'] } },
    ] } };\n`;
  } else {
    files['vitest.config.mjs'] = `export default { test: { projects: ${form === 'glob' ? "['./vitest.*.config.mjs']" : "['./vitest.unit.config.mjs', './vitest.integration.config.mjs']"} } };\n`;
    files['vitest.unit.config.mjs'] = "export default { test: { name: 'unit', include: ['tests/unit.test.ts'], setupFiles: ['tests/owner-setup.ts'] } };\n";
    files['vitest.integration.config.mjs'] = "export default { test: { name: 'integration', include: ['tests/integration.test.ts'], setupFiles: ['tests/owner-setup.ts'] } };\n";
  }
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  symlinkSync(modules, join(root, 'node_modules'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('legacy workspace file definitions receive a wrapper for each project', async (t) => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/vitest-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  writeFileSync(join(root, 'vitest.workspace.mjs'), "export default ['./vitest.unit.config.mjs'];\n");
  writeFileSync(join(root, 'vitest.unit.config.mjs'), "export default { test: { name: 'unit', include: ['tests/unit.test.ts'] } };\n");
  const config = await injectVitestProjects({}, { root, work: root, setupFile: '/cupel/setup.mjs', packageDir: '/cupel',
    workspaceFile: 'vitest.workspace.mjs' });
  assert.equal(config.test.workspace.length, 1);
  const wrapped = await import(pathToFileURL(config.test.workspace[0]).href);
  const project = await wrapped.default({ command: 'serve', mode: 'test' });
  assert.equal(project.test.name, 'unit');
  assert.deepEqual(project.test.include, ['tests/unit.test.ts']);
  assert.deepEqual(project.test.setupFiles, ['/cupel/setup.mjs']);
});

for (const [version, modules] of versions) {
  for (const form of ['inline', 'files', 'glob']) {
    test(`Vitest ${version}: ${form} projects collect coverage and select by name`,
      { skip: !existsSync(join(modules, 'vitest/package.json')) }, async (t) => {
        const p = fixture(modules, form);
        t.after(p.cleanup);
        const config = { runners: { vitest: { tests: 'tests/**/*.test.ts' } } };
        const all = await collectVitest({ root: p.root, config, runs: 1 });
        assert.deepEqual(all.tests.map((row) => row.id), [
          'tests/integration.test.ts::integration zero', 'tests/unit.test.ts::unit positive',
        ]);
        for (const row of all.tests) assert.ok(all.coverage.byTest[row.id]?.['src/score.ts'], row.id);
        const selected = await collectVitest({ root: p.root, config: { runners: { vitest: {
          tests: 'tests/**/*.test.ts', project: 'unit',
        } } }, runs: 1 });
        assert.deepEqual(selected.tests.map((row) => row.id), ['tests/unit.test.ts::unit positive']);
        assert.ok(selected.coverage.byTest[selected.tests[0].id]?.['src/score.ts']);
        if (form === 'inline') {
          const selectedBoth = await collectVitest({ root: p.root, config: { runners: { vitest: {
            tests: 'tests/**/*.test.ts', project: ['unit', 'integration'],
          } } }, runs: 1 });
          assert.equal(selectedBoth.tests.length, 2);
        }
      });
  }
  test(`Vitest ${version}: reports a project that drops Cupel setup`,
    { skip: !existsSync(join(modules, 'vitest/package.json')) }, async (t) => {
      const p = fixture(modules, 'inline');
      t.after(p.cleanup);
      writeFileSync(join(p.root, 'vitest.config.mjs'), `export default { test: { projects: [
        { test: { name: 'unit', include: ['tests/unit.test.ts'] } },
        { plugins: [{ name: 'drop-setup', enforce: 'post', configResolved(config) { config.test.setupFiles = []; } }],
          test: { name: 'integration', include: ['tests/integration.test.ts'] } },
      ] } };\n`);
      await assert.rejects(collectVitest({ root: p.root, runs: 1 }),
        /Vitest hook did not write coverage for .*integration\.test\.ts/);
    });
}
