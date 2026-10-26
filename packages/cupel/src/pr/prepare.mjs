import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertExactGitBaseline } from './git-identity.mjs';
import { sealNodeProfileBaseline } from './artifact.mjs';
import { nodeProfileProducerProof } from './producer.mjs';
import { nodeProfileRuntimeIdentity } from './runtime.mjs';
import { collectNodeProfile } from './profiles/node/collect.mjs';
import { auditNodeReference } from './profiles/node/reference.mjs';
import { criticalProfileSites } from './profiles/node/critical-sites.mjs';
import { runNodeProfileMutationBatch } from './profiles/node/mutation-batch.mjs';
import { assertDeclaredNodeProfileConfig } from './policy.mjs';
import { run as engineRun } from '../engine/index.mjs';
import { assertPrivateOutputPaths } from './output.mjs';
import policies from './profiles/node/input-policy.cjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const schemas = Object.fromEntries(['input', 'config', 'report'].map(name => [name,
  JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'))]));

/** Build one sealed, full Node 26 baseline from exact Git and both readonly runners. */
export function prepareNodeProfileBaseline({ root, baseCommit, files, out,
  artifactPath, config = {}, nodePath, expectedProducerHash,
  inputPolicy = 'strict-v1' }) {
  const started = performance.now();
  inputPolicy = policies.normalizeInputPolicy(inputPolicy);
  if (nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR preparation producer differs from trusted pin');
  const runtime = nodeProfileRuntimeIdentity(nodePath);
  root = resolve(root); out = resolve(out); artifactPath = resolve(artifactPath);
  if (out === root || out.startsWith(`${root}${sep}`) ||
      artifactPath === root || artifactPath.startsWith(`${root}${sep}`))
    throw new Error('Node PR preparation outputs must be outside the subject root');
  const git = assertExactGitBaseline({ root, commit: baseCommit, inputPolicy });
  assertDeclaredNodeProfileConfig(root, git.inputManifest, config);
  assertPrivateOutputPaths(root, [out, artifactPath]);
  mkdirSync(out);
  const collection = collectNodeProfile({ root, files, out: join(out, 'profile'),
    config, runs: 2, nodePath, inputPolicy, expectedProducerHash, mode: 'full' });
  if (collection.input.tests.some(test => test.status === 'failed'))
    throw new Error('Node PR baseline tests failed under the v2 profile');
  const labeled = engineRun('label', { input: collection.input }, config, {}, schemas);
  if (labeled.exit !== 0 || labeled.report.units.some(unit =>
      unit.tier === 'critical' && unit.status !== 'passed'))
    throw new Error('Node PR baseline critical test did not pass under the v2 profile');
  const reference = auditNodeReference({ root, files: collection.fullFiles,
    out: join(out, 'reference'), config, nodePath, inputPolicy,
    expectedProducerHash, expectedIdentity: collection.identity });
  if (reference.kind !== 'complete' ||
      reference.mode !== 'readonly-normal-runner-reference-v1' ||
      reference.identity?.inputManifestHash !== collection.identity.inputManifestHash ||
      reference.identity?.dependencyLockHash !== collection.identity.dependencyLockHash ||
      reference.identity?.producerHash !== expectedProducerHash ||
      reference.identity?.runtimeVersion !== runtime.version ||
      !Array.isArray(reference.runRows) || reference.runRows.length !== 2 ||
      collection.runRows.length !== 2 ||
      reference.runRows.some(rows => collection.runRows.some(profileRows => !same(rows, profileRows))))
    throw new Error(`Node PR readonly reference parity refused: ${reference.reason ?? 'rows or completion differ'}`);
  const current = assertExactGitBaseline({ root, commit: baseCommit, inputPolicy });
  if (!same(current, git)) throw new Error('Node PR Git baseline changed during collection');
  const critical = criticalProfileSites({ root, input: collection.input,
    manifest: git.inputManifest, config, nodePath });
  const mutation = critical.sites.length ? runNodeProfileMutationBatch({ root,
    input: collection.input, selectedMutants: critical.sites,
    out: join(out, 'mutation'), nodePath, inputPolicy, expectedProducerHash,
    expectedIdentity: collection.identity, expectedDependencies: collection.dependencies,
    maxSeconds: critical.maxSeconds }) : null;
  const after = assertExactGitBaseline({ root, commit: baseCommit, inputPolicy });
  if (!same(after, git) || nodeProfileProducerProof().producerHash !== expectedProducerHash ||
      !same(nodeProfileRuntimeIdentity(nodePath), runtime))
    throw new Error('Node PR Git, producer or runtime changed during preparation');
  const artifact = { version: 'cupel-pr-baseline/1', profile: 'node-readonly-files-v2',
    baseCommit, privacyPolicy: inputPolicy, producer: nodeProfileProducerProof(), runtime,
    git, config, collection, reference,
    critical: { ...critical, mutation },
    costs: { totalMs: Math.round(performance.now() - started),
      profileExecutionMs: collection.attempts.reduce((sum, row) => sum + row.costs.executionMs, 0),
      reference: reference.costs ?? null, mutation: mutation?.costs ?? null } };
  assertPrivateOutputPaths(root, [out, artifactPath]);
  const sealed = sealNodeProfileBaseline(artifactPath, artifact,
    { expectedProducerHash, baseCommit });
  return { kind: 'prepared', profile: 'node-readonly-files-v2',
    artifact: sealed, costs: artifact.costs };
}
