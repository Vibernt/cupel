import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import privacy from '../../../packages/cupel/src/pr/profiles/node/privacy.cjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = value => typeof value === 'string' && value && !value.startsWith('/') &&
  !value.includes('\\') && !privacy.privatePath(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');

/** Copy only a previously enumerated regular file, verifying its known bytes. */
export function readPinnedFile(sourceRoot, relative, expectedHash) {
  if (!safe(relative) || !/^[0-9a-f]{64}$/.test(expectedHash))
    throw new Error('derived fixture path or digest invalid');
  const source = join(sourceRoot, relative);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error(`derived fixture source is not a unique regular file: ${relative}`);
  const bytes = readFileSync(source);
  if (hash(bytes) !== expectedHash)
    throw new Error(`derived fixture source changed: ${relative}`);
  return { bytes, mode: stat.mode & 0o777 };
}

/** Copy only a previously enumerated regular file, verifying its known bytes. */
export function copyPinnedFile(sourceRoot, targetRoot, relative, expectedHash) {
  const { bytes, mode } = readPinnedFile(sourceRoot, relative, expectedHash);
  const target = join(targetRoot, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx', mode });
  chmodSync(target, mode);
  return bytes.length;
}

export function copyManifest(sourceRoot, targetRoot, manifest) {
  let bytes = 0;
  for (const [relative, pin] of Object.entries(manifest)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(pin))
      throw new Error(`derived fixture manifest pin invalid: ${relative}`);
    bytes += copyPinnedFile(sourceRoot, targetRoot, relative, pin.slice(7));
  }
  return { files: Object.keys(manifest).length, bytes };
}

export function copyLockedPackages(sourceRoot, targetRoot, setup) {
  let files = 0, bytes = 0;
  for (const [name, pkg] of Object.entries(setup.packages))
    for (const [relative, pin] of Object.entries(pkg.files)) {
      bytes += copyPinnedFile(sourceRoot, targetRoot,
        `node_modules/${name}/${relative}`, pin);
      files++;
    }
  return { files, bytes, packages: Object.keys(setup.packages).sort() };
}
