import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// Modules Cupel injects into a Vitest run. They are copied into the project-local work directory because Vite
// refuses files outside the project root in web-transform environments. Their relative imports are followed and
// copied too, so a new helper module can never be left behind.
const packageDir = fileURLToPath(new URL('../../../', import.meta.url));
const entries = [
  'collect/vitest/projects.mjs',
  'collect/vitest/setup.mjs',
  'collect/vitest/reporter.mjs',
  'mutate/vitest-setup.mjs',
  'mutate/vitest-reporter.mjs',
  'mutate/vitest-plugin.mjs',
];
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

/** Every module reachable from the entries through relative imports, as paths under src/. */
export function injectedModules() {
  const seen = new Set();
  const visit = (module) => {
    if (seen.has(module)) return;
    seen.add(module);
    const text = readFileSync(join(packageDir, 'src', module), 'utf8');
    for (const [, , spec] of text.matchAll(RELATIVE_IMPORT)) {
      const next = posix.normalize(posix.join(posix.dirname(module), spec));
      if (existsSync(join(packageDir, 'src', next))) visit(next);
    }
  };
  for (const entry of entries) visit(entry);
  return [...seen].sort();
}

export function copyInjectedVitestModules(work) {
  const target = join(work, 'injected');
  for (const module of injectedModules()) {
    const dest = join(target, module);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(packageDir, 'src', module), dest);
  }
  return { packageDir, module: (name) => join(target, name) };
}
