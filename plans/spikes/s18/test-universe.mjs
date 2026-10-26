import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const supported = path => /^tests\/(?:.+\.test\.[cm]?[jt]sx?|(?:.*\/)?test_.*\.py)$/.test(path);

/** Names only. The following S16 preflight validates and hashes every HEAD byte. */
export function discoverHeadTests(root) {
  root = resolve(root);
  if (realpathSync(root) !== root)
    throw new Error('S18 HEAD root may not be a symlink');
  const testsRoot = join(root, 'tests');
  if (!lstatSync(testsRoot).isDirectory())
    throw new Error('S18 HEAD tests path must be a regular directory');
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relative = `${rel}/${entry.name}`.split(sep).join('/');
      if (entry.isSymbolicLink())
        throw new Error(`S18 HEAD test-universe symlink refused: ${relative}`);
      if (entry.isDirectory()) walk(path, relative);
      else if (entry.isFile()) {
        if (supported(relative)) files.push(relative);
      } else throw new Error(`S18 HEAD test-universe nonregular entry refused: ${relative}`);
    }
  };
  walk(testsRoot, 'tests');
  return files.sort();
}
