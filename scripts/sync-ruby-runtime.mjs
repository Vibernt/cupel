// Materialise the exact Ruby runtime tree inside the private npm package.
// Run this after changing packages/cupel-ruby/bin or lib; npm pack does not run it.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'packages/cupel-ruby');
const bundled = join(root, 'packages/cupel/ruby');

rmSync(bundled, { recursive: true, force: true });
mkdirSync(bundled, { recursive: true });
for (const folder of ['bin', 'lib']) cpSync(join(source, folder), join(bundled, folder), { recursive: true });
process.stdout.write('Ruby runtime mirror updated: bin and lib\n');
