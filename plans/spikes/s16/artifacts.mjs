import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const safeName = name => /^[a-z0-9-]+\.json$/.test(name);
const rawRoot = resolve(fileURLToPath(new URL('../../../.scratch/s16/', import.meta.url)));
const within = dir => {
  mkdirSync(rawRoot, { recursive: true });
  dir = resolve(dir);
  if (dirname(dir) !== rawRoot || realpathSync(rawRoot) !== rawRoot ||
    (existsSync(dir) && realpathSync(dir) !== dir))
    throw new Error('S16 raw output must be a direct, nonsymlinked .scratch/s16 child');
  return dir;
};
export const rawDirectory = within;

export function saveJson(dir, name, value) {
  dir = within(dir);
  if (!safeName(name)) throw new Error('unsafe S16 artifact name');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export function seal(dir, names) {
  dir = within(dir);
  if (!Array.isArray(names) || !names.length || names.some(name => !safeName(name)) ||
    new Set(names).size !== names.length) throw new Error('invalid S16 artifact set');
  const files = Object.fromEntries(names.sort().map(name => {
    const bytes = readFileSync(join(dir, name));
    return [name, { hash: digest(bytes), bytes: bytes.length }];
  }));
  saveJson(dir, 'manifest.json', { version: 's16-artifacts/1', files });
}

export function loadSealed(dir) {
  dir = within(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version !== 's16-artifacts/1' || !manifest.files ||
    typeof manifest.files !== 'object') throw new Error('S16 artifact manifest invalid');
  return Object.fromEntries(Object.entries(manifest.files).map(([name, expected]) => {
    if (!safeName(name)) throw new Error('S16 artifact path invalid');
    const bytes = readFileSync(join(dir, name));
    if (expected.hash !== digest(bytes) || expected.bytes !== bytes.length)
      throw new Error(`S16 saved evidence differs: ${name}`);
    return [name, JSON.parse(bytes.toString('utf8'))];
  }));
}

export function duplicateSealed(source, target) {
  source = within(source); target = within(target);
  if (existsSync(target)) throw new Error('S16 copied raw directory must be new');
  const files = Object.keys(loadSealed(source));
  mkdirSync(target);
  for (const name of [...files, 'manifest.json'])
    copyFileSync(join(source, name), join(target, name));
  loadSealed(target);
  return files.length;
}
