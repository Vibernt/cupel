// Validate a collected source path using metadata only, before any source content read.
import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PRIVATE_PART = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.ssh|\.aws|\.git|\.scratch|id_rsa|id_ed25519|credentials(?:[._-].*)?|secrets(?:[._-].*)?|private-keys(?:[._-].*)?)$/i;
const DEPENDENCY_PART = /^(?:node_modules|vendor)$/i;
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

export class UnsafeSourcePathError extends Error {}

function parts(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
    isAbsolute(value)) throw new UnsafeSourcePathError('source path is not canonical and relative');
  const components = value.split('/');
  if (components.some(part => !part || part === '.' || part === '..' || part.startsWith('.') ||
    PRIVATE_PART.test(part) || DEPENDENCY_PART.test(part)))
    throw new UnsafeSourcePathError('source path is private or noncanonical');
  return components;
}

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new UnsafeSourcePathError('source path escapes the project root');
  parts(rel.split(sep).join('/'));
}

export function sourcePath(root, expectedRootReal, source) {
  parts(source);
  if (!SOURCE_EXTENSIONS.has(extname(source)))
    throw new UnsafeSourcePathError('source is not a JavaScript or TypeScript file');
  const logicalPath = resolve(join(root, source));
  inside(root, logicalPath);
  const rootReal = realpathSync(root);
  if (rootReal !== expectedRootReal) throw new UnsafeSourcePathError('project root changed');
  const realPath = realpathSync(logicalPath);
  inside(rootReal, realPath);
  const type = statSync(realPath);
  if (!type.isFile() || type.nlink !== 1) throw new UnsafeSourcePathError('source is not a single-link regular file');
  return { logicalPath, rootReal, realPath, device: type.dev, inode: type.ino };
}
