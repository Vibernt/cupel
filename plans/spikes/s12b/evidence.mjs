import { createHash } from 'node:crypto';
import { normalizeInputPolicy, rebuildBaseEvidence, safeInputSnapshot } from './evidence-base.mjs';
import { validateFilesystemEvents, validateProfileEvidence } from './evidence-profile.mjs';

export const VERSION = 'cupel-pr-dependencies/1';
export const CHANNELS = ['imports', 'reads', 'probes', 'directories', 'writes'];
export const REQUIRED_CAPABILITIES = Object.freeze({
  node: ['module-linkage', 'fs-sync', 'fs-async', 'fs-stream', 'fs-descriptor', 'metadata', 'directory'],
  vitest: ['module-linkage', 'fs-sync', 'fs-async', 'fs-stream', 'fs-descriptor', 'metadata', 'directory', 'transform'],
  jest: ['module-linkage', 'fs-sync', 'fs-async', 'fs-stream', 'fs-descriptor', 'metadata', 'directory', 'transform'],
  pytest: ['module-linkage', 'fs-sync', 'fs-async', 'fs-descriptor', 'metadata', 'directory'],
});
export const NODE_PROFILE = 'node-readonly-files-v1';
export const OPAQUE_NPMRC_POLICY = 'express-root-npmrc-opaque-v1';
const NODE_PROFILE_CAPABILITIES = [...REQUIRED_CAPABILITIES.node,
  'readonly-boundary', 'unsupported-controls', 'fs-invocation-origin'];
const ISOLATION = Object.freeze({ node: ['experimental-fresh-process-per-file', NODE_PROFILE],
  vitest: ['experimental-fresh-process-per-file'], jest: ['experimental-fresh-process-per-file'],
  pytest: ['shared-process'] });

export const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
export const sorted = values => [...values].sort();
export const refuse = reason => ({ kind: 'refuse', reason, files: [] });
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');

export function opaqueReferenceGuardError(sidecar, testFiles) {
  const guard = sidecar?.fullReferenceGuard;
  const expected = sorted(testFiles);
  if (guard?.mode !== 'privacy-guarded' || guard.policy !== OPAQUE_NPMRC_POLICY ||
    !Array.isArray(guard.expectedFiles) || !Array.isArray(guard.finishedFiles) ||
    !Array.isArray(guard.errors) || !Array.isArray(guard.denials) ||
    guard.errors.length || guard.denials.length ||
    JSON.stringify(sorted(guard.expectedFiles)) !== JSON.stringify(expected) ||
    JSON.stringify(sorted(guard.finishedFiles)) !== JSON.stringify(expected))
    return 'opaque baseline ordinary full privacy guard proof incomplete';
  return null;
}

function inspectChannels(channels, inventory, label) {
  if (!channels || typeof channels !== 'object') return `${label} missing`;
  for (const channel of CHANNELS) {
    if (!Array.isArray(channels[channel])) return `${label}.${channel} missing`;
    for (const path of channels[channel]) if (!safePath(path)) return `${label}.${channel} has noncanonical path`;
  }
  for (const key of ['capabilities', 'unsupported'])
    if (!Array.isArray(channels[key]) || channels[key].some(value => typeof value !== 'string' || !value))
      return `${label}.${key} missing or invalid`;
  // Observed absent probes may not be in the inventory. All other inputs must be.
  for (const channel of ['imports', 'reads', 'writes'])
    for (const path of channels[channel]) if (!has(inventory, path)) return `${label}.${channel} path absent from inventory: ${path}`;
  return null;
}

export function validateSidecar(sidecar, { runner, runnerVersion, runtimeVersion, testFiles, inventory, root, isolation, configHash,
  environmentPolicyHash, profileRuntimeHash, inputPolicy = 'strict-v1', opaqueRootNpmrc,
  mode = 'baseline' }) {
  if (!Object.hasOwn(REQUIRED_CAPABILITIES, runner)) return `unsupported runner: ${runner}`;
  if (!ISOLATION[runner].includes(isolation)) return `unsupported isolation: ${isolation}`;
  if (isolation === NODE_PROFILE && (runner !== 'node' ||
    !['22.23.3', '26.7.0'].includes(runtimeVersion) || runnerVersion !== runtimeVersion))
    return 'node readonly profile runtime/runner unsupported';
  if (isolation === NODE_PROFILE && (!['baseline', 'selected-head'].includes(mode) ||
    sidecar?.execution?.mode !== mode)) return 'node readonly profile execution mode differs';
  if (isolation === NODE_PROFILE && (sidecar?.execution?.profile !== NODE_PROFILE ||
    !Array.isArray(sidecar?.denials) || sidecar.denials.length))
    return 'node readonly profile marker missing or persistent denials recorded';
  if (isolation === NODE_PROFILE && sidecar?.execution?.inputPolicy !== inputPolicy)
    return 'node readonly input privacy policy differs';
  if (isolation === NODE_PROFILE && sidecar?.execution?.opaqueRootNpmrc !== opaqueRootNpmrc)
    return 'node readonly opaque root .npmrc descriptor differs';
  if (isolation === NODE_PROFILE && inputPolicy === OPAQUE_NPMRC_POLICY && mode === 'baseline') {
    const guardError = opaqueReferenceGuardError(sidecar, testFiles);
    if (guardError) return guardError;
  }
  if (!sidecar || sidecar.version !== VERSION) return 'missing or incompatible dependency sidecar';
  if (sidecar.runner?.name !== runner || sidecar.runner.version !== runnerVersion)
    return 'runner identity missing or differs';
  if (sidecar.runtime?.version !== runtimeVersion || !sidecar.runtime?.name) return 'runtime identity differs';
  const execution = sidecar.execution;
  if (execution?.isolation !== isolation || execution.configHash !== configHash ||
    execution.environmentPolicyHash !== environmentPolicyHash) return 'execution policy identity differs';
  if (isolation === NODE_PROFILE && (!profileRuntimeHash ||
    execution.profileRuntimeHash !== profileRuntimeHash)) return 'node profile runtime source identity differs';
  if (isolation === NODE_PROFILE) {
    const profile = validateProfileEvidence({ sidecar, root, inventory });
    if (profile.error) return profile.error;
    inventory = profile.inventory;
  }
  if (!sidecar.files || typeof sidecar.files !== 'object') return 'per-file dependency evidence missing';
  const expected = sorted(testFiles);
  const completion = sidecar.completion;
  if (!Array.isArray(completion?.expectedFiles) || !Array.isArray(completion?.finishedFiles) ||
    !Array.isArray(completion?.errors) || completion.errors.length ||
    JSON.stringify(sorted(completion.expectedFiles)) !== JSON.stringify(expected) ||
    JSON.stringify(sorted(completion.finishedFiles)) !== JSON.stringify(expected) ||
    JSON.stringify(sorted(Object.keys(sidecar.files))) !== JSON.stringify(expected)) return 'dependency capture incomplete';
  for (const [name, channels] of [...Object.entries(sidecar.files), ['global', sidecar.global]]) {
    if (name !== 'global' && !safePath(name)) return `invalid test owner: ${name}`;
    const error = inspectChannels(channels, inventory, name);
    if (error) return error;
    if (isolation === NODE_PROFILE) {
      const originError = validateFilesystemEvents(channels, name);
      if (originError) return originError;
    }
  }
  for (const [name, channels] of [['global', sidecar.global], ...Object.entries(sidecar.files)]) {
    if (channels.unsupported.length) return `${name} unsupported: ${channels.unsupported.join(', ')}`;
    if (channels.writes.length) return `${name} repository writes: ${channels.writes.join(', ')}`;
    if (name !== 'global') {
      const required = isolation === NODE_PROFILE ? [...NODE_PROFILE_CAPABILITIES,
        mode === 'baseline' ? 'results-parity' : 'baseline-parity-bound',
        inputPolicy === OPAQUE_NPMRC_POLICY &&
          (mode === 'baseline' ? 'privacy-guarded-full' : 'baseline-privacy-bound')]
        .filter(Boolean) : REQUIRED_CAPABILITIES[runner];
      const missing = required.filter(cap => !channels.capabilities.includes(cap));
      if (missing.length) return `${name} capability evidence missing: ${missing.join(', ')}`;
    }
  }
  return null;
}

export function makeBundle({ baseRoot, input, sidecar, runner, runnerVersion, runtime, config, tierConfig = {},
  baseCommit, dependencyInstall, probe, environmentPolicy, executionPolicy, inputPolicy }) {
  if (!baseCommit || !runnerVersion || !dependencyInstall || !probe || !environmentPolicy || !executionPolicy)
    throw new Error('base commit, dependency installation, probe and policies are required');
  inputPolicy = normalizeInputPolicy(inputPolicy);
  const base = safeInputSnapshot(baseRoot, { inputPolicy });
  const core = rebuildBaseEvidence({ input, runner, runtime, config, tierConfig }, base.files);
  const inventory = core.identity.files;
  const testFiles = sorted(new Set(input.tests.map(test => test.file)));
  const policy = { isolation: executionPolicy, configHash: digest(config),
    environmentPolicyHash: digest(environmentPolicy), profileRuntimeHash: environmentPolicy.runtimeHash };
  const error = validateSidecar(sidecar, { runner, runnerVersion, runtimeVersion: runtime, testFiles, inventory,
    root: baseRoot, inputPolicy, opaqueRootNpmrc: base.opaqueRootNpmrc, ...policy });
  if (error) throw new Error(error);
  if (dependencyInstall.complete !== true || probe.complete !== true)
    throw new Error('dependency installation or probe identity is incomplete');
  return { version: VERSION, core, sidecar, binding: { baseCommit, tree: digest(inventory),
    trackedFiles: digest(inventory), core: digest(core), testFiles: digest(testFiles), config: digest(config),
    tierConfig: digest(tierConfig), runtime, runner, runnerVersion, dependencyInstall: digest(dependencyInstall),
    probe: digest(probe), environmentPolicy: digest(environmentPolicy), executionPolicy,
    inputPolicy, opaqueRootNpmrc: base.opaqueRootNpmrc,
    sidecar: digest(sidecar) } };
}

export function validateBundle(bundle, args) {
  if (bundle?.version !== VERSION || !bundle.core || !bundle.sidecar || !bundle.binding)
    return 'missing baseline dependency bundle';
  if (!Array.isArray(bundle.core.input?.tests) || !bundle.core.input.coverage ||
    !bundle.core.identity?.files || !Array.isArray(bundle.core.criticalFiles))
    return 'baseline core inventory or coverage missing';
  if (args.dependencyInstall?.complete !== true || args.probe?.complete !== true)
    return 'dependency installation or probe identity is incomplete';
  let inventory; let inputPolicy; let opaqueRootNpmrc;
  try {
    inputPolicy = normalizeInputPolicy(args.inputPolicy);
    ({ files: inventory, opaqueRootNpmrc } = safeInputSnapshot(args.baseRoot, { inputPolicy }));
  } catch (error) { return error.message; }
  const b = bundle.binding;
  const checks = { baseCommit: args.baseCommit, tree: digest(inventory), trackedFiles: digest(inventory),
    core: digest(bundle.core),
    testFiles: digest(sorted(new Set(bundle.core.input.tests.map(test => test.file)))),
    config: digest(args.config), tierConfig: digest(args.tierConfig ?? {}), runtime: args.runtime,
    runner: args.runner, runnerVersion: args.runnerVersion,
    dependencyInstall: digest(args.dependencyInstall), probe: digest(args.probe),
    environmentPolicy: digest(args.environmentPolicy), executionPolicy: args.executionPolicy,
    inputPolicy, opaqueRootNpmrc,
    sidecar: digest(bundle.sidecar) };
  for (const [key, value] of Object.entries(checks)) if (b[key] !== value) return `baseline ${key} identity differs`;
  if (digest(bundle.core.identity.files) !== b.tree ||
    bundle.core.identity.tree !== digest(inventory).slice('sha256:'.length) ||
    bundle.core.identity.input !== digest(bundle.core.input).slice('sha256:'.length) ||
    bundle.core.identity.criticalFiles !== digest(bundle.core.criticalFiles).slice('sha256:'.length))
    return 'baseline core inventory or critical labels differ';
  try {
    const rebuilt = rebuildBaseEvidence({ input: bundle.core.input, runner: args.runner,
      runtime: args.runtime, config: args.config, tierConfig: args.tierConfig ?? {} }, inventory);
    if (digest(rebuilt) !== digest(bundle.core)) return 'baseline core differs from verified engine labels';
  } catch (error) { return error.message; }
  return validateSidecar(bundle.sidecar, { runner: args.runner, runnerVersion: args.runnerVersion,
    runtimeVersion: args.runtime,
    testFiles: sorted(new Set(bundle.core.input.tests.map(test => test.file))), inventory,
    root: args.baseRoot,
    isolation: args.executionPolicy, configHash: digest(args.config),
    environmentPolicyHash: digest(args.environmentPolicy),
    profileRuntimeHash: args.environmentPolicy.runtimeHash, inputPolicy, opaqueRootNpmrc });
}

export function verifyRunParity(ordinary, constrained) {
  const normalize = (rows, name) => {
    if (!Array.isArray(rows) || !rows.length) throw new Error(`${name} test rows missing`);
    const normalized = rows.map(row => {
      if (typeof row?.id !== 'string' || !row.id || typeof row.file !== 'string' || !row.file ||
        !['passed', 'failed', 'skipped'].includes(row.status))
        throw new Error(`${name} test row invalid`);
      return { id: row.id, file: row.file, status: row.status };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(normalized.map(row => row.id)).size !== normalized.length)
      throw new Error(`${name} duplicate test IDs`);
    return normalized;
  };
  try {
    const left = normalize(ordinary, 'ordinary full');
    const right = normalize(constrained, 'constrained full');
    if (JSON.stringify(left) !== JSON.stringify(right)) return 'ordinary and constrained full test IDs/status differ';
    return null;
  } catch (error) { return error.message; }
}

export function verifyCollectorParity(inputTests, ordinaryRows) {
  if (!Array.isArray(inputTests) || inputTests.some(test =>
    typeof test.file !== 'string' || typeof test.name !== 'string' || !test.name))
    return 'collector test inventory missing file or name';
  const names = inputTests.map(test => `${test.file}\0${test.name}`);
  if (new Set(names).size !== names.length)
    return 'duplicate test names in a file are unsupported by this profile';
  return verifyRunParity(inputTests.map(test => ({ file: test.file, id: `${test.name}#1`,
    status: test.status })), ordinaryRows);
}
