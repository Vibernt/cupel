// Read-only installed-framework startup probe. Writes only ignored .scratch/s26-framework-profiles/.
import { cpSync, mkdirSync, symlinkSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkVitestModules } from '../../../packages/cupel/test/vitest-modules.mjs';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const scratch = join(repo, '.scratch/s26-framework-profiles');
mkdirSync(scratch, { recursive: true });
const nodeVersions = [process.execPath, '/opt/homebrew/opt/node@22/bin/node'];
const cases = [
  { name: 'jest-30.2.0', source: join(repo, 'spec/conformance/adapters/jest'),
    files: ['package.json', 'jest.config.cjs', 'transform.cjs', 'src', 'tests'],
    modules: join(repo, 'spec/conformance/adapters/jest/node_modules'),
    command: (root) => [join(root, 'node_modules/jest/bin/jest.js'), '--no-cache'] },
  { name: 'vitest-4.1.11', source: join(repo, 'spec/conformance/adapters/vitest'),
    files: ['package.json', 'vitest.config.mjs', 'src', 'tests'],
    modules: '/Users/vid/codecrystal/hub-ts/node_modules',
    command: (root) => [join(root, 'node_modules/vitest/vitest.mjs'), 'run'] },
  { name: 'vitest-5.0.1', source: join(repo, 'spec/conformance/adapters/vitest'),
    files: ['package.json', 'vitest.config.mjs', 'src', 'tests'],
    modules: '/Users/vid/codecrystal/web/node_modules',
    command: (root) => [join(root, 'node_modules/vitest/vitest.mjs'), 'run'] },
];
const output = [];
for (const spec of cases) {
  const root = mkdtempSync(join(scratch, spec.name + '-'));
  for (const file of spec.files) cpSync(join(spec.source, file), join(root, file), { recursive: true });
  if (spec.name.startsWith('jest')) symlinkSync(spec.modules, join(root, 'node_modules'), 'dir');
  else linkVitestModules(root, spec.modules);
  for (const node of nodeVersions) {
    const privateHome = join(root, '.private-home-' + (node.includes('node@22') ? '22' : '26'));
    mkdirSync(privateHome);
    const [entry, ...args] = spec.command(root);
    const child = spawnSync(node, [entry, ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: privateHome, TMPDIR: privateHome, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' },
      encoding: 'utf8', timeout: 45_000, maxBuffer: 2 << 20,
    });
    const key = node.includes('node@22') ? '22.23.3' : '26.7.0';
    const text = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    writeFileSync(join(root, `ordinary-${key}.out`), text);
    const expectedTests = spec.name.startsWith('jest') ? 8 : 4;
    const finished = spec.name.startsWith('jest') ? /Tests:\s+8 passed, 8 total/.test(text) : /Tests\s+4 passed \(4\)/.test(text);
    output.push({ runner: spec.name, node: key, root, exit: child.status, signal: child.signal,
      timedOut: child.error?.code === 'ETIMEDOUT', expectedTests, finished, outputTail: text.slice(-1000) });
  }
}
writeFileSync(join(scratch, 'ordinary-summary.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.map(({ runner, node, exit, signal, timedOut, root }) =>
  ({ runner, node, exit, signal, timedOut, root }))));
if (output.some(row => row.exit !== 0 || row.signal || row.timedOut || !row.finished))
  throw new Error('ordinary framework startup or expected test inventory failed');
