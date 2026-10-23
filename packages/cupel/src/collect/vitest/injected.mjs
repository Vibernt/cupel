import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../../../', import.meta.url));
const modules = [
  'collect/vitest/projects.mjs',
  'collect/vitest/setup.mjs',
  'collect/vitest/reporter.mjs',
  'collect/vitest/interpreters.mjs',
  'collect/node/intervals.mjs',
  'mutate/vitest-setup.mjs',
  'mutate/vitest-reporter.mjs',
  'mutate/vitest-plugin.mjs',
];

export function copyInjectedVitestModules(work) {
  const target = join(work, 'injected');
  for (const module of modules) {
    const dest = join(target, module);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(packageDir, 'src', module), dest);
  }
  return { packageDir, module: (name) => join(target, name) };
}
