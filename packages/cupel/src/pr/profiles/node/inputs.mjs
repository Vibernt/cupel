import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import privacy from './privacy.cjs';
import policies from './input-policy.cjs';
const {privateFilename, privateDirectory} = privacy;
const {EXPRESS,normalizeInputPolicy}=policies;
const hashBytes = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/**
 * Read and hash regular fixture inputs after a filename-only privacy preflight.
 * .git metadata is omitted. Optional hooks let tests prove that refusal happens
 * before either file content reads or hashing; production callers use defaults.
 */
export function readOnlyInputSnapshot(root, {readFile = readFileSync, hash = hashBytes,
  nodeModules = 'reject',inputPolicy = 'strict-v1'} = {}) {
  inputPolicy=normalizeInputPolicy(inputPolicy);
  root = resolve(root);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error('node profile refuses symlinked or non-directory input root');
  root = realpathSync(root);
  const inputPaths = [];
  let opaqueRootNpmrc='absent';
  const visit = (dir, parts = []) => {
    for (const name of readdirSync(dir).sort()) {
      // Ignore Git internals before stat or descent, including credential-looking files within them.
      if (name === '.git') continue;
      if (inputPolicy===EXPRESS && parts.length===0 && name==='.npmrc') {
        const stat=lstatSync(join(dir,name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)
          throw new Error('node profile refuses opaque root .npmrc alias or non-file');
        opaqueRootNpmrc='regular';
        continue;
      }
      if (privateFilename(name) || privateDirectory(parts, name))
        throw new Error('node profile refuses private input path (filename preflight)');
      // Never recurse into an installed package tree.
      if (name === 'node_modules') {
        if (nodeModules === 'skip') continue;
        throw new Error(`node profile refuses package dependencies: ${join(dir, name)}`);
      }
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`node profile refuses symlink: ${path}`);
      if (stat.isDirectory()) visit(path, [...parts, name]);
      else if (stat.isFile()) inputPaths.push(path);
      else throw new Error(`node profile refuses non-file input: ${path}`);
    }
  };
  visit(root);
  // Complete the metadata-only privacy/type preflight before opening any inputs.
  const files = {};
  for (const path of inputPaths.sort())
    files[relative(root, path).split(sep).join('/')] = hash(readFile(path));
  return {files,opaqueRootNpmrc};
}
export function readOnlyInventory(root,options={}) {
  return readOnlyInputSnapshot(root,options).files;
}
