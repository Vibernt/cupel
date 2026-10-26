import { observedDependencyEvidence } from '../s12b/node-profile/dependencies.mjs';
import { OPAQUE_NPMRC_POLICY } from '../s12b/evidence.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function selectedDependencyEvidence(observed, allPostEvidence, lock) {
  const roots = Object.keys(lock.packages).sort((a, b) => b.length - a.length);
  const needed = new Set();
  for (const path of observed) {
    if (!path.includes('node_modules/')) continue;
    const root = roots.find(key => path === `${key}/package.json` ||
      path.startsWith(`${key}/`));
    if (root) { needed.add(path); needed.add(`${root}/package.json`); }
  }
  return Object.fromEntries(Object.entries(allPostEvidence)
    .filter(([path]) => needed.has(path)));
}

/** Attach only verified, freshly observed HEAD facts to the selected trace. */
export function completeHeadTrace({ capture, pre, post, headRoot, baselineDependencies,
  inputPolicy }) {
  const sidecar = capture.sidecar;
  for (const entry of Object.values(sidecar.files)) for (const path of entry.imports)
    if (/\.(?:ts|mts|cts)$/.test(path)) {
      if (!pre.manifest[path]) sidecar.global.unsupported.push(`missing-native-typescript-source:${path}`);
      else sidecar.nativeTypeScript.files[path] = pre.manifest[path];
    }
  if (!same(pre.manifest, post.manifest) || pre.opaqueRootNpmrc !== post.opaqueRootNpmrc)
    sidecar.global.unsupported.push('changed-input-inventory');
  if (!same(pre.dependencyLock, post.dependencyLock))
    sidecar.global.unsupported.push('changed-dependency-lock');
  const observed = Object.values(sidecar.files).flatMap(entry => [
    ...entry.imports, ...entry.reads, ...entry.probes, ...entry.directories]);
  const postEvidence = observedDependencyEvidence(headRoot,
    [...new Set([...observed, ...Object.keys(baselineDependencies)])], post.dependencyLock);
  const postBaseline = Object.fromEntries(Object.entries(postEvidence)
    .filter(([path]) => Object.hasOwn(baselineDependencies, path)));
  if (!same(postBaseline, baselineDependencies))
    sidecar.global.unsupported.push('baseline-dependency-bytes-changed-during-run');
  sidecar.dependencies = { lockHash: pre.dependencyLock.lockHash,
    files: selectedDependencyEvidence(observed, postEvidence, post.dependencyLock) };
  if (Object.keys(sidecar.dependencies.files).some(path =>
    !Object.hasOwn(baselineDependencies, path)))
    sidecar.global.unsupported.push('new-dependency-observation');
  for (const entry of Object.values(sidecar.files)) {
    entry.capabilities.push('baseline-parity-bound');
    if (inputPolicy === OPAQUE_NPMRC_POLICY)
      entry.capabilities.push('baseline-privacy-bound');
  }
  return sidecar.dependencies.files;
}
