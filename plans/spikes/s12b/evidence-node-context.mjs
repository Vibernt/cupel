import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeFileInventory } from './evidence-base.mjs';
import { normalizeInputPolicy } from './evidence-base.mjs';
import { profileRequestSnapshot } from './node-profile/snapshot.mjs';
import { digest, makeBundle, NODE_PROFILE } from './evidence.mjs';

const profileRoot = resolve(import.meta.dirname, 'node-profile');
export const FROZEN_PROFILE_RUNTIME_HASH =
  'sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b';
const runtimeFiles = ['bootstrap.cjs', 'policy.cjs', 'modules.cjs', 'filesystem.cjs', 'descriptors.cjs',
  'provenance.cjs', 'privacy.cjs', 'input-policy.cjs', 'nondeterminism.cjs', 'reporter.mjs', 'inputs.mjs',
  'dependencies.mjs', 'opaque-target.cjs', 'opaque-module.cjs', 'opaque-package.mjs',
  'opaque-guard-trace.cjs', 'opaque-guard-fs.cjs', 'opaque-guard-modules.cjs', 'opaque-guard.cjs',
  'opaque-full.mjs', 'snapshot.mjs', 'launch.mjs'];
const shaBytes = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;

export function nodeVersion(nodePath) {
  const probe = spawnSync(nodePath, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0 || !/^v(?:22\.23\.3|26\.7\.0)\n?$/.test(probe.stdout))
    throw new Error(`Node profile requires exact 22.23.3 or 26.7.0 runtime: ${nodePath}`);
  return probe.stdout.trim().slice(1);
}

export function nodeProfilePolicy({ root, files, version, inputPolicy }) {
  root = resolve(root);
  inputPolicy = normalizeInputPolicy(inputPolicy);
  const { manifest, opaqueRootNpmrc, dependencyLock: lock, identity } =
    profileRequestSnapshot({ root, files, version, inputPolicy });
  const runtimeHash = digest(runtimeFiles.map(file => [file, shaBytes(readFileSync(join(profileRoot, file)))]));
  if (runtimeHash !== FROZEN_PROFILE_RUNTIME_HASH)
    throw new Error('trusted Node profile runtime differs from frozen capability proof');
  const config = { profile: NODE_PROFILE, inputPolicy, opaqueRootNpmrc, files: [...files].sort(),
    packages: Object.fromEntries(Object.entries(manifest).filter(([path]) => path.endsWith('package.json'))),
    dependencyLockHash: lock.lockHash, lockedPackages: lock.packages };
  const environmentPolicy = { profile: NODE_PROFILE, inputPolicy, opaqueRootNpmrc, version,
    env: { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' }, runtimeHash,
    reads: ['fixture-root', 'profile-runtime', 'per-file-private-tmp'],
    writes: ['per-file-private-tmp'], child: false, worker: false, addons: false,
    wasi: false, network: false, nativeTypeStripping: true };
  if (identity.profileRuntimeHash !== runtimeHash || digest(config) !== identity.configHash ||
    digest(environmentPolicy) !== identity.environmentPolicyHash ||
    digest(manifest) !== identity.inputManifestHash || identity.dependencyLockHash !== lock.lockHash)
    throw new Error('local and launcher profile identities differ');
  return { config, environmentPolicy, identity, runtimeHash, inputPolicy, opaqueRootNpmrc };
}

export function makeNodeProfileBundle({ baseRoot, input, sidecar, nodePath = process.execPath,
  baseCommit, inputPolicy }) {
  if (!baseCommit) throw new Error('base commit/tree identity is required');
  const version = nodeVersion(nodePath);
  const files = sidecar?.completion?.expectedFiles;
  if (!Array.isArray(files)) throw new Error('baseline expected test files missing');
  const policy = nodeProfilePolicy({ root: baseRoot, files, version, inputPolicy });
  const dependencyInstall = { complete: true, kind: 'node-locked-pure-js',
    nodeBinary: shaBytes(readFileSync(nodePath)),
    lockHash: sidecar.dependencies?.lockHash ?? null,
    observedFiles: sidecar.dependencies?.files ?? null };
  const args = { baseRoot, runner: 'node', runnerVersion: version, runtime: version,
    config: policy.config, environmentPolicy: policy.environmentPolicy,
    executionPolicy: NODE_PROFILE, baseCommit, dependencyInstall, inputPolicy: policy.inputPolicy,
    probe: { complete: true, profile: NODE_PROFILE, files: safeFileInventory(profileRoot) } };
  return { args, bundle: makeBundle({ ...args, input, sidecar }) };
}
