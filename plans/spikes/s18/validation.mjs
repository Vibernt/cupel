import { digest, NODE_PROFILE, OPAQUE_NPMRC_POLICY, opaqueReferenceGuardError,
  verifyCollectorParity, verifyRunParity } from '../s12b/evidence.mjs';
import { rebuildBaseEvidence } from '../s12b/evidence-base.mjs';
import { validateFilesystemEvents } from '../s12b/evidence-profile.mjs';
import { ARTIFACT_VERSION } from './artifact.mjs';

const hash = value => /^sha256:[0-9a-f]{64}$/.test(value);
const bareHash = value => /^[0-9a-f]{64}$/.test(value);
const safePath = path => typeof path === 'string' && path.length > 0 &&
  !path.startsWith('/') && !path.includes('\\') &&
  !path.split('/').some(part => !part || part === '.' || part === '..');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort();
const testFile = path => /^tests\/(?:.+\.test\.[cm]?[jt]sx?|(?:.*\/)?test_.*\.py)$/.test(path);
const requiredCapabilities = ['module-linkage', 'fs-sync', 'fs-async', 'fs-stream',
  'fs-descriptor', 'metadata', 'directory', 'readonly-boundary',
  'unsupported-controls', 'fs-invocation-origin', 'results-parity'];

function assert(condition, reason) {
  if (!condition) throw new Error(`S18 sealed baseline: ${reason}`);
}

function validateSavedSidecar(sidecar, inventory, lock, files, args) {
  const execution = sidecar?.execution;
  assert(sidecar?.version === 'cupel-pr-dependencies/1', 'sidecar version differs');
  assert(sidecar.runner?.name === 'node' && sidecar.runner.version === args.runtime &&
    sidecar.runtime?.name === 'node' && sidecar.runtime.version === args.runtime,
  'runner/runtime identity differs');
  assert(execution?.mode === 'baseline' && execution.isolation === NODE_PROFILE &&
    execution.profile === NODE_PROFILE && execution.inputPolicy === args.inputPolicy &&
    execution.opaqueRootNpmrc === args.config.opaqueRootNpmrc &&
    execution.configHash === digest(args.config) &&
    execution.environmentPolicyHash === digest(args.environmentPolicy) &&
    execution.profileRuntimeHash === args.environmentPolicy.runtimeHash,
  'baseline profile policy differs');
  const manifest = Object.fromEntries(Object.entries(inventory).map(([path, value]) =>
    [path, `sha256:${value}`]));
  assert(execution.inputManifestHash === digest(manifest), 'input manifest identity differs');
  assert(sidecar.dependencies?.lockHash === lock.lockHash &&
    execution.dependencyLockHash === lock.lockHash &&
    args.dependencyInstall.lockHash === lock.lockHash &&
    same(args.dependencyInstall.observedFiles, sidecar.dependencies.files),
  'dependency lock or observed evidence differs');
  const dependencies = sidecar.dependencies.files;
  assert(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies),
    'observed dependency inventory missing');
  const packageRoots = Object.keys(lock.packages).sort((a, b) => b.length - a.length);
  for (const [path, value] of Object.entries(dependencies)) {
    assert(safePath(path) && path.includes('node_modules/') && hash(value),
      `invalid observed dependency hash: ${path}`);
    const owner = packageRoots.find(key => path === `${key}/package.json` ||
      path.startsWith(`${key}/`));
    assert(owner && hash(dependencies[`${owner}/package.json`]),
      `observed package metadata missing: ${path}`);
  }
  assert(Array.isArray(sidecar.denials) && sidecar.denials.length === 0,
    'persistent baseline denials recorded');
  const completion = sidecar.completion;
  assert(same(completion?.expectedFiles, files) && same(completion?.finishedFiles, files) &&
    Array.isArray(completion?.errors) && completion.errors.length === 0 &&
    same(sorted(Object.keys(sidecar.files ?? {})), files), 'baseline capture incomplete');
  const extended = { ...inventory, ...Object.fromEntries(Object.entries(dependencies)
    .map(([path, value]) => [path, value.slice(7)])) };
  for (const [label, channels] of [...Object.entries(sidecar.files), ['global', sidecar.global]]) {
    assert(channels && Array.isArray(channels.capabilities) &&
      channels.capabilities.every(value => typeof value === 'string' && value.length > 0) &&
      Array.isArray(channels.unsupported) &&
      channels.unsupported.every(value => typeof value === 'string' && value.length > 0) &&
      channels.unsupported.length === 0,
    `${label} capability/unsupported evidence invalid`);
    for (const channel of ['imports', 'reads', 'probes', 'directories', 'writes']) {
      assert(Array.isArray(channels[channel]) && channels[channel].every(safePath),
        `${label}.${channel} paths invalid`);
    }
    assert(channels.writes.length === 0, `${label} repository writes recorded`);
    for (const channel of ['imports', 'reads']) for (const path of channels[channel])
      assert(Object.hasOwn(extended, path), `${label}.${channel} path absent: ${path}`);
    const eventError = validateFilesystemEvents(channels, label);
    assert(!eventError, eventError);
    if (label !== 'global') for (const cap of [...requiredCapabilities,
      args.inputPolicy === OPAQUE_NPMRC_POLICY && 'privacy-guarded-full'].filter(Boolean))
      assert(channels.capabilities.includes(cap), `${label} capability missing: ${cap}`);
    for (const path of [...channels.imports, ...channels.reads, ...channels.probes]) {
      if (!path.includes('node_modules/')) continue;
      const owner = packageRoots.find(key => path === `${key}/package.json` ||
        path.startsWith(`${key}/`));
      assert(owner && hash(dependencies[path]) &&
        channels.capabilities.includes('locked-pure-js'),
      `${label} locked dependency proof missing: ${path}`);
    }
    if (label !== 'global' && (/\.(?:ts|mts|cts)$/.test(label) ||
      channels.imports.some(path => /\.(?:ts|mts|cts)$/.test(path))))
      assert(channels.capabilities.includes('native-typescript'),
        `${label} native TypeScript capability missing`);
  }
  const ts = sidecar.nativeTypeScript?.files;
  assert(ts && typeof ts === 'object' && !Array.isArray(ts),
    'native TypeScript source evidence missing');
  const importedTs = new Set([...Object.values(sidecar.files), sidecar.global]
    .flatMap(row => row.imports).filter(path => /\.(?:ts|mts|cts)$/.test(path)));
  assert(same(sorted(Object.keys(ts)), sorted(importedTs)),
    'native TypeScript source coverage differs');
  for (const [path, value] of Object.entries(ts))
    assert(safePath(path) && value === `sha256:${inventory[path]}`,
      `native TypeScript raw-source identity differs: ${path}`);
  if (args.inputPolicy === OPAQUE_NPMRC_POLICY)
    assert(!opaqueReferenceGuardError(sidecar, files),
      'privacy-guarded ordinary full proof incomplete');
}

/** Rebuild all baseline claims using only the sealed inventory and saved trace. */
export function validateSealedBaseline(artifact, { expectedBaseCommit, expectedProducerHash,
  producer, runtime, inputPolicy }) {
  assert(artifact?.version === ARTIFACT_VERSION, 'artifact version differs');
  assert(same(Object.keys(artifact).sort(), ['args', 'baseCommit', 'baseline', 'inputPolicy',
    'producer', 'producerHash', 'version'].sort()), 'artifact schema differs');
  assert(artifact.baseCommit === expectedBaseCommit &&
    artifact.args?.baseCommit === expectedBaseCommit, 'base commit differs');
  assert(artifact.inputPolicy === inputPolicy && artifact.args?.inputPolicy === inputPolicy,
    'input policy differs');
  assert(artifact.producerHash === expectedProducerHash &&
    same(artifact.producer, producer) && digest(artifact.producer) === expectedProducerHash,
  'preparation producer differs');
  const { bundle, rows, lock, fullFiles } = artifact.baseline ?? {};
  const args = artifact.args;
  assert(args && !Object.hasOwn(args, 'baseRoot') &&
    args.runner === 'node' && args.runnerVersion === runtime && args.runtime === runtime &&
    args.executionPolicy === NODE_PROFILE &&
    args.environmentPolicy?.version === runtime && args.config?.profile === NODE_PROFILE &&
    args.environmentPolicy?.profile === NODE_PROFILE &&
    args.environmentPolicy.runtimeHash === artifact.producer.referenceProfileHash &&
    args.config.inputPolicy === inputPolicy &&
    args.environmentPolicy.inputPolicy === inputPolicy &&
    args.dependencyInstall?.complete === true &&
    args.dependencyInstall.kind === 'node-locked-pure-js' &&
    hash(args.dependencyInstall.nodeBinary) &&
    args.probe?.complete === true && args.probe.profile === NODE_PROFILE,
  'baseline arguments or runtime invalid');
  assert(same(args.environmentPolicy.env,
    { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' }) &&
    same(args.environmentPolicy.reads,
      ['fixture-root', 'profile-runtime', 'per-file-private-tmp']) &&
    same(args.environmentPolicy.writes, ['per-file-private-tmp']) &&
    ['child', 'worker', 'addons', 'wasi', 'network'].every(key =>
      args.environmentPolicy[key] === false) &&
    args.environmentPolicy.nativeTypeStripping === true,
  'baseline execution permissions differ');
  assert(bundle?.version === 'cupel-pr-dependencies/1' && bundle.core && bundle.binding &&
    bundle.sidecar && !Object.hasOwn(bundle, 'baseRoot'), 'bundle schema invalid');
  const inventory = bundle.core.identity?.files;
  assert(inventory && typeof inventory === 'object' && !Array.isArray(inventory) &&
    Object.entries(inventory).every(([path, value]) => safePath(path) && bareHash(value)),
  'canonical input inventory missing or invalid');
  assert(Array.isArray(fullFiles) && fullFiles.length > 0 &&
    same(fullFiles, sorted(new Set(fullFiles))) && fullFiles.every(testFile) &&
    fullFiles.every(path => Object.hasOwn(inventory, path)),
  'complete canonical test file inventory missing');
  const input = bundle.core.input;
  assert(input?.sources && Object.entries(input.sources).every(([path, value]) =>
    hash(value?.hash) && value.hash === `sha256:${inventory[path]}`),
  'canonical input source hashes missing or differ');
  assert(same(fullFiles, sorted(new Set(input.tests?.map(test => test.file)))) &&
    same(fullFiles, args.config.files), 'collector/profile file universe differs');
  assert(Array.isArray(rows?.ordinary) && Array.isArray(rows?.constrained) &&
    rows.ordinary.length > 0 && rows.constrained.length > 0 &&
    !verifyRunParity(rows.ordinary, rows.constrained) &&
    !verifyCollectorParity(input.tests, rows.ordinary),
  'saved ordinary/constrained/collector parity differs');
  const b = bundle.binding;
  const checks = { baseCommit: expectedBaseCommit, tree: digest(inventory),
    trackedFiles: digest(inventory), core: digest(bundle.core),
    testFiles: digest(fullFiles), config: digest(args.config),
    tierConfig: digest(args.tierConfig ?? {}), runtime, runner: 'node',
    runnerVersion: runtime, dependencyInstall: digest(args.dependencyInstall),
    probe: digest(args.probe), environmentPolicy: digest(args.environmentPolicy),
    executionPolicy: NODE_PROFILE, inputPolicy,
    opaqueRootNpmrc: args.config.opaqueRootNpmrc, sidecar: digest(bundle.sidecar) };
  for (const [key, value] of Object.entries(checks))
    assert(b[key] === value, `baseline ${key} binding differs`);
  assert(bundle.core.identity.tree === digest(inventory).slice(7) &&
    bundle.core.identity.input === digest(input).slice(7) &&
    bundle.core.identity.criticalFiles === digest(bundle.core.criticalFiles).slice(7),
  'baseline core inventory or critical labels differ');
  const rebuilt = rebuildBaseEvidence({ input, runner: 'node', runtime,
    config: args.config, tierConfig: args.tierConfig ?? {} }, inventory);
  assert(same(rebuilt, bundle.core), 'critical labels or engine evidence differs');
  assert(lock && lock.lockHash === args.config.dependencyLockHash &&
    same(lock.packages, args.config.lockedPackages) &&
    Object.entries(lock.packages).every(([path, value]) =>
      safePath(path) && path.includes('node_modules/') &&
      typeof value.name === 'string' && typeof value.version === 'string'),
  'saved installed package closure differs');
  validateSavedSidecar(bundle.sidecar, inventory, lock, fullFiles, args);
  return { bundle, args, fullFiles, lock, rows };
}
