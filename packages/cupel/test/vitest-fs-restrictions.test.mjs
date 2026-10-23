import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { mutateVitest } from '../src/mutate/index.mjs';
import { injectVitestProjects } from '../src/collect/vitest/projects.mjs';
import { linkVitestModules } from './vitest-modules.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repo, 'spec/conformance/adapters/vitest');
const versions = [
  ['4.1.11', '/Users/vid/codecrystal/hub-ts/node_modules'],
  ['5.0.1', '/Users/vid/codecrystal/web/node_modules'],
];

test('Cupel adds package access while retaining the project file allow list', async () => {
  const result = await injectVitestProjects({ server: { fs: { strict: true, allow: ['.'] } } }, {
    root: '/project', setupFile: '/project/.scratch/setup.mjs', packageDir: '/cupel/packages/cupel',
  });
  assert.deepEqual(result.server.fs.allow, ['.', '/project', '/cupel/packages/cupel']);
});

for (const [version, modules] of versions) {
  test(`Vitest ${version}: strict Vite file access supports collection and mutation`,
    { skip: !existsSync(join(modules, 'vitest/package.json')) }, async (t) => {
      mkdirSync(join(repo, '.scratch'), { recursive: true });
      const root = mkdtempSync(join(repo, '.scratch/vitest-fs-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      cpSync(fixture, root, { recursive: true });
      linkVitestModules(root, modules);
      writeFileSync(join(root, 'web-node-environment.mjs'),
        "import { builtinEnvironments } from 'vitest/runtime'; export default { ...builtinEnvironments.node, name: 'web-node', viteEnvironment: 'client' };\n");
      writeFileSync(join(root, 'vitest.config.mjs'),
        "export default { server: { fs: { strict: true, allow: ['.'] } }, test: { environment: './web-node-environment.mjs', globals: true, include: ['tests/**/*.test.ts'] } };\n");
      const input = await collectVitest({ root, runs: 1 });
      assert.equal(input.tests.length, 4);
      assert.ok(input.tests.every((row) => row.status === 'passed'));
      const mutation = await mutateVitest({ root, input, config: { mutation: { maxMutants: 1, maxSeconds: 30, seed: 17 } },
        collectorKind: 'vitest', jobs: 1, timeoutFloorMs: 600, scope: { changed: { 'src/math.ts': '8' } } });
      assert.equal(mutation.mutants.length, 1);
      assert.notEqual(mutation.mutants[0].status, 'error');
    });
}
