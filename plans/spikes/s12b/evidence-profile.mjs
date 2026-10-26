import { createHash } from 'node:crypto';
import { loadLockedDependencies, observedDependencyEvidence } from './node-profile/dependencies.mjs';

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');
const nativeTs = path => /\.(?:ts|mts|cts)$/.test(path);
const filesystemChannels = ['reads', 'probes', 'directories', 'writes'];

export function validateFilesystemEvents(channels, label) {
  if (!Array.isArray(channels.filesystemEvents))
    return `${label} filesystem invocation provenance missing`;
  const fromEvents = Object.fromEntries(filesystemChannels.map(channel => [channel, new Set()]));
  for (const event of channels.filesystemEvents) {
    if (!event || !filesystemChannels.includes(event.channel) || !safePath(event.path) ||
      typeof event.operation !== 'string' || !event.operation ||
      !['loader', 'application', 'unknown'].includes(event.origin))
      return `${label} filesystem invocation provenance invalid`;
    fromEvents[event.channel].add(event.path);
  }
  for (const channel of filesystemChannels) {
    const observed = [...new Set(channels[channel] ?? [])].sort();
    const classified = [...fromEvents[channel]].sort();
    if (JSON.stringify(observed) !== JSON.stringify(classified))
      return `${label}.${channel} differs from invocation provenance`;
  }
  return null;
}

/** Verify producer-side identity against actual locked and repository bytes. */
export function validateProfileEvidence({ sidecar, root, inventory }) {
  const execution = sidecar.execution;
  if (execution.inputManifestHash !== digest(Object.fromEntries(Object.entries(inventory).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0)
    .map(([path, hash]) => [path, `sha256:${hash}`]))))
    return { error: 'node readonly profile input manifest differs' };
  if (!root || !sidecar.dependencies || typeof sidecar.dependencies.files !== 'object' ||
    !sidecar.dependencies.files) return { error: 'node readonly dependency evidence missing' };
  let observed; let lock;
  try {
    lock = loadLockedDependencies(root);
    if (execution.dependencyLockHash !== lock.lockHash || sidecar.dependencies.lockHash !== lock.lockHash)
      return { error: 'node readonly dependency lock identity differs' };
    observed = observedDependencyEvidence(root, Object.keys(sidecar.dependencies.files), lock);
    if (digest(observed) !== digest(sidecar.dependencies.files))
      return { error: 'node readonly dependency file hashes differ' };
  } catch (error) { return { error: `node readonly dependency evidence invalid: ${error.message}` }; }
  const extended = { ...inventory, ...Object.fromEntries(Object.entries(observed)
    .map(([path, hash]) => [path, hash.slice('sha256:'.length)])) };
  const roots = Object.keys(lock.packages).sort((a, b) => b.length - a.length);
  for (const channels of [...Object.values(sidecar.files ?? {}), sidecar.global ?? {}]) {
    for (const path of [...(channels.imports ?? []), ...(channels.reads ?? []), ...(channels.probes ?? [])]) {
      if (!path.includes('node_modules/')) continue;
      const packageRoot = roots.find(key => path === `${key}/package.json` || path.startsWith(`${key}/`));
      if (!packageRoot || !Object.hasOwn(observed, path) ||
        !Object.hasOwn(observed, `${packageRoot}/package.json`))
        return { error: `node readonly observed package metadata missing: ${path}` };
    }
  }
  const tsFiles = sidecar.nativeTypeScript?.files;
  if (!tsFiles || typeof tsFiles !== 'object' || Array.isArray(tsFiles))
    return { error: 'native TypeScript raw-source evidence missing' };
  const importedTs = new Set([...Object.values(sidecar.files ?? {}), sidecar.global ?? {}]
    .flatMap(channels => channels.imports ?? []).filter(nativeTs));
  for (const [path, hash] of Object.entries(tsFiles)) {
    if (!safePath(path) || !nativeTs(path) || !Object.hasOwn(inventory, path) ||
      hash !== `sha256:${inventory[path]}` || !importedTs.has(path))
      return { error: `native TypeScript raw-source identity differs: ${path}` };
  }
  for (const path of importedTs) if (!Object.hasOwn(tsFiles, path))
    return { error: `native TypeScript import lacks raw-source evidence: ${path}` };
  for (const [owner, channels] of Object.entries(sidecar.files ?? {}))
    if ((nativeTs(owner) || channels.imports.some(nativeTs)) &&
      !channels.capabilities.includes('native-typescript'))
      return { error: `${owner} native TypeScript capability missing` };
  for (const [owner, channels] of [...Object.entries(sidecar.files ?? {}), ['global', sidecar.global ?? {}]])
    if ([...(channels.imports ?? []), ...(channels.reads ?? []), ...(channels.probes ?? [])]
      .some(path => path.includes('node_modules/')) &&
      !(channels.capabilities ?? []).includes('locked-pure-js'))
      return { error: `${owner} locked pure JavaScript capability missing` };
  return { inventory: extended, error: null };
}
