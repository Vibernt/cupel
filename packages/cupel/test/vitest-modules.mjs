import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

// Keep Vite's transient config bundle in the fixture, never in the read-only dependency tree.
export function linkVitestModules(root, modules) {
  const local = join(root, 'node_modules');
  mkdirSync(local);
  for (const entry of readdirSync(modules)) {
    if (entry === '.vite-temp') continue;
    symlinkSync(join(modules, entry), join(local, entry));
  }
  mkdirSync(join(local, '.vite-temp'));
}
