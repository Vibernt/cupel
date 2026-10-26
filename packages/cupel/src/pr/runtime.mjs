import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeVersion } from './profiles/node/snapshot.mjs';

/** Bind the exact local Node executable, beyond its printable version. */
export function nodeProfileRuntimeIdentity(nodePath) {
  if (typeof nodePath !== 'string' || !nodePath.startsWith('/'))
    throw new Error('Node PR requires an absolute Node executable path');
  const path = resolve(nodePath), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('Node PR runtime executable is symlinked or nonregular');
  const version = runtimeVersion(path);
  if (version !== '26.7.0') throw new Error('Node v2 selective runtime requires Node 26.7.0');
  const bytes = readFileSync(path);
  return { version, path,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.length };
}
