import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_PROFILE_RUNTIME_HASH } from '../s12b/evidence-node-context.mjs';
import { digest } from '../s12b/evidence.mjs';

const HOOK = fileURLToPath(new URL('../s12b/node-profile/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const HOOK_FILES = [
  'bootstrap.cjs', 'policy.cjs', 'modules.cjs', 'filesystem.cjs',
  'descriptors.cjs', 'provenance.cjs', 'privacy.cjs', 'input-policy.cjs',
  'nondeterminism.cjs', 'reporter.mjs', 'opaque-target.cjs', 'opaque-module.cjs',
];
const COORDINATOR_FILES = [
  ...['producer', 'snapshot', 'selection', 'capture', 'validation', 'request']
    .map(name => `plans/spikes/s16/${name}.mjs`),
  ...['evidence-base', 'evidence-profile', 'evidence', 'evidence-node-context']
    .map(name => `plans/spikes/s12b/${name}.mjs`),
  ...['advice', 'commands', 'config', 'index', 'integrity', 'keyorder',
    'lines', 'match', 'model', 'order', 'rational', 'review', 'schema']
    .map(name => `packages/cupel/src/engine/${name}.mjs`),
  ...['assertions', 'pseudo'].map(name => `packages/cupel/src/analysis/${name}.mjs`),
  ...['input', 'config', 'report'].map(name => `spec/schemas/${name}.schema.json`),
];

const hashFile = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const manifestHash = (base, prefix, names) => digest(names.sort().map(file =>
  [`${prefix}/${file}`, hashFile(join(base, file))]));
const coordinatorHash = () => digest(COORDINATOR_FILES.sort().map(file =>
  [file, hashFile(join(REPO, file))]));

export function producerProof(referenceProfileHash) {
  if (referenceProfileHash !== FROZEN_PROFILE_RUNTIME_HASH)
    throw new Error('trusted S12b reference profile differs from frozen capability proof');
  const producer = {
    version: 'cupel-s16-producer/1',
    referenceProfileHash: FROZEN_PROFILE_RUNTIME_HASH,
    hookRuntimeHash: manifestHash(HOOK, 'plans/spikes/s12b/node-profile', HOOK_FILES),
    requestCoordinatorHash: coordinatorHash(),
  };
  return { producer, producerHash: digest(producer) };
}
