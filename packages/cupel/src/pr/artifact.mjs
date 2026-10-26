import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { nodeProfileProducerProof } from './producer.mjs';
import { nodeProfileRuntimeIdentity } from './runtime.mjs';
import { run as engineRun } from '../engine/index.mjs';
import policies from './profiles/node/input-policy.cjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const PIN = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const schemas = Object.fromEntries(['input', 'config', 'report'].map(name => [name,
  JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'))]));

function validate(artifact, { expectedProducerHash, baseCommit }) {
  if (!artifact || artifact.version !== 'cupel-pr-baseline/1' ||
      artifact.profile !== 'node-readonly-files-v2' ||
      artifact.baseCommit !== baseCommit ||
      ![policies.STRICT, policies.EXPRESS].includes(artifact.privacyPolicy) ||
      artifact.producer?.producerHash !== expectedProducerHash ||
      artifact.runtime?.version !== '26.7.0' ||
      !same(nodeProfileRuntimeIdentity(artifact.runtime.path), artifact.runtime) ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR baseline identity, privacy or producer differs');
  const { git, collection, reference, critical, config } = artifact;
  const opaque = git?.opaqueRootNpmrc === 'regular';
  if (!['absent', 'regular'].includes(git?.opaqueRootNpmrc) ||
      (opaque && artifact.privacyPolicy !== policies.EXPRESS) ||
      (opaque ? git.opaqueGit?.path !== '.npmrc' ||
        !['100644', '100755'].includes(git.opaqueGit?.mode) ||
        !COMMIT.test(git.opaqueGit?.oid ?? '') : git.opaqueGit !== null) ||
      Object.hasOwn(git?.inputManifest ?? {}, '.npmrc'))
    throw new Error('Node PR baseline opaque root descriptor or Git metadata invalid');
  if (!git || git.commit !== baseCommit || !git.inputManifest ||
      !collection || collection.mode !== 'full' ||
      collection.inputPolicy !== artifact.privacyPolicy || !Array.isArray(collection.fullFiles) ||
      !Array.isArray(collection.runRows) || collection.runRows.length !== 2 ||
      !collection.observations ||
      !collection.input || collection.input.runtime?.name !== 'node' ||
      collection.input.runtime.version !== '26.7.0' ||
      collection.input.coverage?.granularity !== 'test' ||
      !Array.isArray(collection.input.tests) ||
      collection.input.tests.some(test => test.status === 'failed') ||
      collection.identity?.inputManifestHash !== sha(JSON.stringify(git.inputManifest)) ||
      collection.identity?.producerHash !== expectedProducerHash ||
      !critical || critical.scope !== 'full-critical-sources' ||
      !Array.isArray(critical.sites) || typeof config !== 'object')
    throw new Error('Node PR baseline collection or critical evidence missing');
  if (!reference || reference.kind !== 'complete' ||
      reference.inputPolicy !== artifact.privacyPolicy ||
      reference.mode !== 'readonly-normal-runner-reference-v1' ||
      !same(reference.fullFiles, collection.fullFiles) ||
      reference.identity?.producerHash !== expectedProducerHash ||
      reference.identity.inputManifestHash !== collection.identity.inputManifestHash ||
      reference.identity.dependencyLockHash !== collection.identity.dependencyLockHash ||
      reference.identity.runtimeVersion !== '26.7.0' ||
      !PIN.test(reference.identity.policyHash ?? '') ||
      !Array.isArray(reference.runRows) || reference.runRows.length !== 2 ||
      !Array.isArray(reference.processProofs) || reference.processProofs.length !== 2 ||
      reference.runRows.some(rows => collection.runRows.some(profileRows => !same(rows, profileRows))))
    throw new Error('Node PR baseline readonly reference parity or identity missing');
  for (const [index, proof] of reference.processProofs.entries())
    if (!proof || proof.run !== index || proof.complete !== true ||
        !same(proof.expectedFiles, collection.fullFiles) ||
        !same(proof.seenFiles, collection.fullFiles) ||
        !Array.isArray(proof.denials) || proof.denials.length ||
        !Number.isSafeInteger(proof.parentPid) ||
        !Array.isArray(proof.childPids) || proof.childPids.length !== collection.fullFiles.length ||
        new Set(proof.childPids).size !== proof.childPids.length)
      throw new Error('Node PR baseline readonly reference process proof incomplete');
  if (!same(Object.keys(collection.observations).sort(), [...collection.fullFiles].sort()))
    throw new Error('Node PR baseline file observations incomplete');
  for (const evidence of Object.values(collection.observations))
    if (!evidence || !['imports', 'reads', 'probes', 'directories', 'writes', 'filesystemEvents']
        .every(key => Array.isArray(evidence[key])) || evidence.writes.length)
      throw new Error('Node PR baseline trace observations malformed or writable');
  if (!same([...new Set(collection.input.tests.map(test => test.file))].sort(),
      [...collection.fullFiles].sort()))
    throw new Error('Node PR baseline full test inventory differs');
  const checked = engineRun('validate', { input: collection.input }, config, {}, schemas);
  if (checked.exit !== 0)
    throw new Error(`Node PR baseline canonical input invalid: ${JSON.stringify(checked.report.diagnostics)}`);
  for (const [source, row] of Object.entries(collection.input.sources ?? {}))
    if (row.hash !== git.inputManifest[source])
      throw new Error(`Node PR baseline source differs from Git inventory: ${source}`);
  const ids = critical.sites.map(site => site.id);
  if (new Set(ids).size !== ids.length) throw new Error('Node PR baseline critical site IDs duplicated');
  const mutation = critical.mutation;
  if (ids.length) {
    if (mutation?.kind !== 'complete' || mutation.scope !== 'explicit-mutant-batch' ||
        mutation.complete !== true || !same(ids.sort(), mutation.mutants?.map(row => row.id).sort()) ||
        mutation.mutants.some(row => !['killed', 'survived'].includes(row.status) ||
          row.status === 'survived' && row.confirmations !== 2))
      throw new Error('Node PR baseline critical mutation incomplete');
  } else if (mutation !== null) {
    throw new Error('Node PR baseline empty site set has unexpected mutation evidence');
  }
  return artifact;
}

/** Save a newly produced baseline exactly once; caller retains the returned external pin. */
export function sealNodeProfileBaseline(path, artifact, { expectedProducerHash, baseCommit }) {
  if (!PIN.test(expectedProducerHash ?? '') || !COMMIT.test(baseCommit ?? ''))
    throw new Error('Node PR baseline requires exact external producer and commit pins');
  validate(artifact, { expectedProducerHash, baseCommit });
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  if (bytes.length > (32 << 20)) throw new Error('Node PR baseline artifact exceeds 32 MiB');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

/** Read an immutable artifact only by independently supplied byte and producer pins. */
export function loadPinnedNodeProfileBaseline(path, { expectedBaselineHash,
  expectedProducerHash, baseCommit }) {
  if (!PIN.test(expectedBaselineHash ?? '') || !PIN.test(expectedProducerHash ?? '') ||
      !COMMIT.test(baseCommit ?? ''))
    throw new Error('Node PR baseline requires external artifact, producer and commit pins');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > (32 << 20))
    throw new Error('Node PR baseline artifact is not a bounded unique regular file');
  const bytes = readFileSync(path);
  if (sha(bytes) !== expectedBaselineHash)
    throw new Error('Node PR baseline artifact bytes differ from trusted pin');
  let artifact;
  try { artifact = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Node PR baseline artifact JSON malformed: ${error.message}`); }
  return validate(artifact, { expectedProducerHash, baseCommit });
}
