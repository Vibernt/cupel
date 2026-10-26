import { digest, NODE_PROFILE, OPAQUE_NPMRC_POLICY, opaqueReferenceGuardError,
  refuse, sorted } from '../s12b/evidence.mjs';
import { validateFilesystemEvents } from '../s12b/evidence-profile.mjs';

const CHANNELS = ['imports', 'reads', 'probes', 'directories', 'writes'];
const REQUIRED = ['module-linkage', 'fs-sync', 'fs-async', 'fs-stream', 'fs-descriptor',
  'metadata', 'directory', 'readonly-boundary', 'unsupported-controls',
  'fs-invocation-origin', 'baseline-parity-bound'];
const safePath = path => typeof path === 'string' && path.length > 0 &&
  !path.startsWith('/') && !path.includes('\\') &&
  !path.split('/').some(part => !part || part === '.' || part === '..');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function channelsError(channels, inventory, label, inputPolicy) {
  if (!channels || typeof channels !== 'object') return `${label} missing`;
  for (const channel of CHANNELS) {
    if (!Array.isArray(channels[channel])) return `${label}.${channel} missing`;
    for (const path of channels[channel]) if (!safePath(path))
      return `${label}.${channel} has noncanonical path`;
  }
  for (const key of ['capabilities', 'unsupported'])
    if (!Array.isArray(channels[key]) || channels[key].some(value =>
      typeof value !== 'string' || !value)) return `${label}.${key} missing or invalid`;
  for (const channel of ['imports', 'reads', 'writes'])
    for (const path of channels[channel]) if (!Object.hasOwn(inventory, path))
      return `${label}.${channel} path absent from inventory: ${path}`;
  const originError = validateFilesystemEvents(channels, label);
  if (originError) return originError;
  if (channels.unsupported.length) return `${label} unsupported: ${channels.unsupported.join(', ')}`;
  if (channels.writes.length) return `${label} repository writes: ${channels.writes.join(', ')}`;
  if (label !== 'global') {
    const required = [...REQUIRED, inputPolicy === OPAQUE_NPMRC_POLICY &&
      'baseline-privacy-bound'].filter(Boolean);
    const missing = required.filter(cap => !channels.capabilities.includes(cap));
    if (missing.length) return `${label} capability evidence missing: ${missing.join(', ')}`;
  }
  return null;
}

/** Check selected sidecar only against the coordinator's private post snapshot. */
export function assessVerifiedHead({ bundle, decision, capture, pre, post,
  postDependencies, producer, producerHash, headEnvironmentPolicyHash }) {
  const sidecar = capture?.sidecar;
  if (decision.kind !== 'selected') return refuse(decision.reason);
  if (!sidecar || sidecar.version !== 'cupel-pr-dependencies/1')
    return refuse('head dependency trace: missing or incompatible dependency sidecar');
  const execution = sidecar.execution;
  if (!same(pre.manifest, post.manifest) ||
    pre.opaqueRootNpmrc !== post.opaqueRootNpmrc)
    return refuse('head dependency trace: changed-input-inventory');
  if (!same(pre.dependencyLock, post.dependencyLock))
    return refuse('head dependency trace: changed-dependency-lock');
  if (!same(pre.config, post.config) || !same(pre.environmentPolicy, post.environmentPolicy) ||
    !same(pre.identity, post.identity))
    return refuse('head dependency trace: local profile identity changed during request');
  if (sidecar.runner?.name !== 'node' || sidecar.runner.version !== pre.environmentPolicy.version ||
    sidecar.runtime?.name !== 'node' || sidecar.runtime.version !== pre.environmentPolicy.version)
    return refuse('head dependency trace: runner or runtime identity differs');
  if (execution?.mode !== 'selected-head' || execution.isolation !== NODE_PROFILE ||
    execution.profile !== NODE_PROFILE || execution.inputPolicy !== pre.inputPolicy ||
    execution.opaqueRootNpmrc !== post.opaqueRootNpmrc ||
    execution.configHash !== pre.identity.configHash ||
    execution.environmentPolicyHash !== headEnvironmentPolicyHash ||
    execution.inputManifestHash !== post.identity.inputManifestHash ||
    execution.dependencyLockHash !== post.dependencyLock.lockHash ||
    execution.profileRuntimeHash !== producerHash ||
    execution.baselineConfigHash !== bundle.sidecar.execution.configHash ||
    execution.baselineProfileRuntimeHash !== pre.runtimeHash ||
    execution.baselineProfileRuntimeHash !== bundle.sidecar.execution.profileRuntimeHash ||
    !same(execution.producer, producer) || digest(execution.producer) !== producerHash)
    return refuse('head dependency trace: selected producer, policy or lineage identity differs');
  if (execution.dependencyLockHash !== bundle.sidecar.execution.dependencyLockHash)
    return refuse('head dependency trace: baseline dependency lock identity differs');
  if (pre.inputPolicy === OPAQUE_NPMRC_POLICY) {
    const baselineFiles = bundle.sidecar.completion?.expectedFiles ?? [];
    if (opaqueReferenceGuardError(bundle.sidecar, baselineFiles) ||
      bundle.binding.sidecar !== digest(bundle.sidecar) ||
      Object.values(bundle.sidecar.files ?? {}).some(row =>
        !row.capabilities?.includes('privacy-guarded-full')))
      return refuse('selected head baseline privacy guard proof differs');
  }
  if (!sidecar.dependencies || sidecar.dependencies.lockHash !== post.dependencyLock.lockHash ||
    !same(sidecar.dependencies.files, postDependencies))
    return refuse('head dependency trace: dependency bytes differ from trusted post snapshot');
  for (const [path, hash] of Object.entries(postDependencies))
    if (bundle.sidecar.dependencies?.files?.[path] !== hash)
      return refuse(`selected head dependency differs or was unseen at baseline: ${path}`);
  if (!Array.isArray(sidecar.denials) || sidecar.denials.length)
    return refuse('head dependency trace: persistent denials recorded');
  const completion = sidecar.completion;
  if (!Array.isArray(completion?.expectedFiles) || !Array.isArray(completion.finishedFiles) ||
    !Array.isArray(completion.errors) || completion.errors.length ||
    !same(sorted(completion.expectedFiles), decision.files) ||
    !same(sorted(completion.finishedFiles), decision.files) ||
    !same(sorted(Object.keys(sidecar.files ?? {})), decision.files))
    return refuse('head dependency trace: dependency capture incomplete');
  const inventory = { ...post.inventory, ...Object.fromEntries(Object.entries(postDependencies)
    .map(([path, hash]) => [path, hash.slice('sha256:'.length)])) };
  const roots = Object.keys(post.dependencyLock.packages).sort((a, b) => b.length - a.length);
  for (const [label, channels] of [...Object.entries(sidecar.files), ['global', sidecar.global]]) {
    if (label !== 'global' && !safePath(label)) return refuse(`invalid test owner: ${label}`);
    const error = channelsError(channels, inventory, label, pre.inputPolicy);
    if (error) return refuse(`head dependency trace: ${error}`);
    for (const path of [...channels.imports, ...channels.reads, ...channels.probes]) {
      if (!path.includes('node_modules/')) continue;
      const packageRoot = roots.find(key => path === `${key}/package.json` ||
        path.startsWith(`${key}/`));
      if (!packageRoot || !Object.hasOwn(postDependencies, path) ||
        !Object.hasOwn(postDependencies, `${packageRoot}/package.json`))
        return refuse(`head dependency trace: observed package metadata missing: ${path}`);
    }
    if ([...channels.imports, ...channels.reads, ...channels.probes]
      .some(path => path.includes('node_modules/')) &&
      !channels.capabilities.includes('locked-pure-js'))
      return refuse(`head dependency trace: ${label} locked pure JavaScript capability missing`);
    if ((/\.(?:ts|mts|cts)$/.test(label) || channels.imports.some(path =>
      /\.(?:ts|mts|cts)$/.test(path))) && !channels.capabilities.includes('native-typescript'))
      return refuse(`head dependency trace: ${label} native TypeScript capability missing`);
  }
  const tsFiles = sidecar.nativeTypeScript?.files;
  if (!tsFiles || typeof tsFiles !== 'object' || Array.isArray(tsFiles))
    return refuse('head dependency trace: native TypeScript raw-source evidence missing');
  const importedTs = new Set([...Object.values(sidecar.files), sidecar.global]
    .flatMap(channels => channels.imports).filter(path => /\.(?:ts|mts|cts)$/.test(path)));
  for (const [path, hash] of Object.entries(tsFiles))
    if (!safePath(path) || !/\.(?:ts|mts|cts)$/.test(path) ||
      post.manifest[path] !== hash || !importedTs.has(path))
      return refuse(`head dependency trace: native TypeScript raw-source identity differs: ${path}`);
  for (const path of importedTs) if (!Object.hasOwn(tsFiles, path))
    return refuse(`head dependency trace: native TypeScript import lacks raw-source evidence: ${path}`);
  return { kind: 'accepted', files: decision.files,
    reason: 'selected head trace complete and supported' };
}
