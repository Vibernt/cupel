import { resolve } from 'node:path';
import { profileRequestSnapshot } from '../s12b/node-profile/snapshot.mjs';
import { normalizeInputPolicy } from '../s12b/evidence-base.mjs';
import { digest, NODE_PROFILE } from '../s12b/evidence.mjs';
import { FROZEN_PROFILE_RUNTIME_HASH } from '../s12b/evidence-node-context.mjs';

/** One complete privacy preflight, input hash pass and lock validation. */
export function headSnapshot({ root, files, version, inputPolicy }) {
  root = resolve(root);
  inputPolicy = normalizeInputPolicy(inputPolicy);
  const snapshot = profileRequestSnapshot({ root, files, version, inputPolicy });
  if (!['absent', 'regular'].includes(snapshot.opaqueRootNpmrc))
    throw new Error('opaque root .npmrc descriptor invalid');
  const inventory = Object.fromEntries(Object.entries(snapshot.manifest).map(([path, hash]) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid inventory hash: ${path}`);
    return [path, hash.slice('sha256:'.length)];
  }));
  const runtimeHash = snapshot.identity.profileRuntimeHash;
  if (runtimeHash !== FROZEN_PROFILE_RUNTIME_HASH)
    throw new Error('trusted Node profile runtime differs from frozen capability proof');
  const config = { profile: NODE_PROFILE, inputPolicy, opaqueRootNpmrc: snapshot.opaqueRootNpmrc,
    files: [...files].sort(),
    packages: Object.fromEntries(Object.entries(snapshot.manifest)
      .filter(([path]) => path.endsWith('package.json'))),
    dependencyLockHash: snapshot.dependencyLock.lockHash,
    lockedPackages: snapshot.dependencyLock.packages };
  const environmentPolicy = { profile: NODE_PROFILE, inputPolicy,
    opaqueRootNpmrc: snapshot.opaqueRootNpmrc, version,
    env: { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' }, runtimeHash,
    reads: ['fixture-root', 'profile-runtime', 'per-file-private-tmp'],
    writes: ['per-file-private-tmp'], child: false, worker: false, addons: false,
    wasi: false, network: false, nativeTypeStripping: true };
  if (digest(config) !== snapshot.identity.configHash ||
    digest(environmentPolicy) !== snapshot.identity.environmentPolicyHash ||
    digest(snapshot.manifest) !== snapshot.identity.inputManifestHash ||
    snapshot.identity.dependencyLockHash !== snapshot.dependencyLock.lockHash)
    throw new Error('local and launcher profile identities differ');
  return { ...snapshot, inventory, config, environmentPolicy, runtimeHash, root, files };
}
