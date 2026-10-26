import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { jsonObjects } from '../collect/go/process.mjs';
import { refuse } from './errors.mjs';
import { safeListedGoName } from './path.mjs';

const CHANNELS = [
  'CgoFiles', 'CFiles', 'CXXFiles', 'MFiles', 'HFiles', 'FFiles', 'SFiles',
  'SwigFiles', 'SwigCXXFiles', 'SysoFiles', 'EmbedFiles', 'TestEmbedFiles',
  'XTestEmbedFiles', 'EmbedPatterns', 'TestEmbedPatterns', 'XTestEmbedPatterns',
];
const topLevel = (name) => /^Test[A-Z0-9_]/.test(name);
const rel = (root, path) => relative(root, path).split(sep).join('/');

function listedFile(root, dir, file) {
  safeListedGoName(file);
  const path = resolve(join(dir, file));
  const name = rel(root, path);
  safeListedGoName(name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path)
    refuse('source-path', `listed Go file is not a single-link regular file: ${name}`);
  return { path, name };
}

export function parseInventory(root, listing, input, metrics) {
  const packages = jsonObjects(listing);
  if (!packages.length) refuse('inventory', 'go list returned no module packages');
  const sourcePkg = new Map();
  const testPkg = new Map();
  const testPackages = [];
  const allFiles = [];
  for (const pkg of packages) {
    if (pkg.Error || pkg.DepsErrors?.length) refuse('inventory', `go list failed for ${pkg.ImportPath}`);
    for (const channel of CHANNELS) if (pkg[channel]?.length)
      refuse('unsupported-go-channel', `${pkg.ImportPath} uses ${channel}; Go mutation source overlay is unverified for this channel`);
    const files = [...(pkg.GoFiles ?? []), ...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? []), ...(pkg.IgnoredGoFiles ?? [])];
    for (const file of files) allFiles.push(listedFile(root, pkg.Dir, file));
  }
  for (const { path, name } of allFiles) {
      const contents = readFileSync(path, 'utf8');
      if (metrics) metrics.inventoryReads = (metrics.inventoryReads ?? 0) + 1;
      if (/\/\/go:embed\b|import\s*(?:\(\s*)?"C"/.test(contents))
        refuse('unsupported-go-channel', `${name} uses cgo or go:embed`);
      if (/^\s*\/\/(?:go:build|\s*\+build|line\b)/m.test(contents))
        refuse('unsupported-go-channel', `${name} uses build or line directives`);
  }
  for (const pkg of packages) {
    for (const file of pkg.GoFiles ?? []) sourcePkg.set(listedFile(root, pkg.Dir, file).name, pkg.ImportPath);
    const testFiles = [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])];
    if (testFiles.length) testPackages.push(pkg.ImportPath);
    for (const file of testFiles) testPkg.set(listedFile(root, pkg.Dir, file).name, pkg.ImportPath);
  }

  for (const source of Object.keys(input.sources))
    if (!sourcePkg.has(source)) refuse('inventory', `collected Go source is absent from go list: ${source}`);
  const lookup = new Map();
  const ids = new Set();
  for (const test of input.tests) {
    if (!topLevel(test.name) || test.id !== `${test.file}::${test.name}` || ids.has(test.id))
      refuse('inventory', `noncanonical or duplicate Go test id: ${test.id}`);
    if (test.spawnsInterpreter)
      refuse('unsupported-go-channel', `Go test spawns a compiler or test binary: ${test.id}`);
    const pkg = testPkg.get(test.file);
    if (!pkg) refuse('inventory', `collected Go test file is absent from go list: ${test.file}`);
    const key = `${pkg}\0${test.name}`;
    if (lookup.has(key)) refuse('inventory', `duplicate Go test name in package: ${test.name}`);
    ids.add(test.id);
    lookup.set(key, test);
  }
  if (!lookup.size) refuse('inventory', 'Go mutation requires a complete nonempty top-level test inventory');
  return { packages, testPackages: [...new Set(testPackages)].sort(), lookup, sourcePkg };
}
