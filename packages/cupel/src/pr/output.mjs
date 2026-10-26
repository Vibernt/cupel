import { lstatSync, realpathSync } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';

/** Check private output ancestry without following a symlink into subject. */
export function assertPrivateOutputPaths(root, paths) {
  root = resolve(root);
  if (realpathSync(root) !== root)
    throw new Error('Node PR output subject root is symlinked');
  for (const requested of paths) {
    if (typeof requested !== 'string' || !requested.startsWith('/'))
      throw new Error('Node PR output requires absolute paths');
    const path = resolve(requested);
    if (path === root || path.startsWith(`${root}${sep}`))
      throw new Error('Node PR output is inside the subject root');
    let parent = dirname(path);
    while (true) {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Node PR output ancestor is symlinked or not a directory');
      if (parent === parse(parent).root) break;
      parent = dirname(parent);
    }
    if (realpathSync(dirname(path)) === root ||
        realpathSync(dirname(path)).startsWith(`${root}${sep}`))
      throw new Error('Node PR output resolves inside the subject root');
  }
}
