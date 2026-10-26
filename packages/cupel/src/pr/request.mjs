import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validate } from '../engine/schema.mjs';
import { loadPinnedNodeProfileBaseline } from './artifact.mjs';
import { assertExactGitHead } from './git-identity.mjs';
import { nodeProfileProducerProof } from './producer.mjs';
import { nodeProfileRuntimeIdentity } from './runtime.mjs';
import { selectNodeProfileHead } from './selection.mjs';
import { nodeProfileMutationScope } from './scope.mjs';
import { assessNodeProfileRequest } from './assessment.mjs';
import { collectNodeProfile } from './profiles/node/collect.mjs';
import { observedDependencyEvidence, loadLockedDependencies } from './profiles/node/dependencies.mjs';
import { runNodeProfileMutationBatch } from './profiles/node/mutation-batch.mjs';
import { assertDeclaredNodeProfileConfig } from './policy.mjs';
import { assertPrivateOutputPaths } from './output.mjs';
import policies from './profiles/node/input-policy.cjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const privateOutside = (root, path) => path !== root && !path.startsWith(`${root}${sep}`);
const resultSchema = JSON.parse(readFileSync(new URL('../../schemas/pr-result.schema.json', import.meta.url)));

/** Execute one pinned Node 26 PR request, with no reusable caller snapshot. */
export function runNodeProfileRequest({ root, baseCommit, baselinePath,
  expectedBaselineHash, expectedProducerHash, nodePath, out,
  resultPath, inputPolicy = 'strict-v1' }) {
  const started = performance.now();
  root = resolve(root); out = resolve(out); resultPath = resolve(resultPath);
  if (!privateOutside(root, out) || !privateOutside(root, resultPath) ||
      resultPath === out || resultPath.startsWith(`${out}${sep}`))
    throw new Error('Node PR request outputs must be outside subject and distinct');
  inputPolicy = policies.normalizeInputPolicy(inputPolicy);
  const baseline = loadPinnedNodeProfileBaseline(baselinePath,
    { expectedBaselineHash, expectedProducerHash, baseCommit });
  const producer = nodeProfileProducerProof();
  const runtime = nodeProfileRuntimeIdentity(nodePath);
  if (producer.producerHash !== expectedProducerHash || !same(runtime, baseline.runtime) ||
      baseline.privacyPolicy !== inputPolicy)
    throw new Error('Node PR request runtime, producer or privacy policy differs from sealed base');
  const git = assertExactGitHead({ root, baseCommit, inputPolicy });
  assertDeclaredNodeProfileConfig(root, git.inputManifest, baseline.config);
  if (!same(git.opaqueGit, baseline.git.opaqueGit) ||
      git.opaqueRootNpmrc !== baseline.git.opaqueRootNpmrc)
    throw new Error('Node PR opaque root metadata differs from sealed baseline');
  assertPrivateOutputPaths(root, [out, resultPath]);
  const decision = selectNodeProfileHead({ root, baseline });
  if (decision.headInventoryHash !== sha(JSON.stringify(git.inputManifest)))
    throw new Error('Node PR HEAD inventory changed during selection');
  const lock = loadLockedDependencies(root);
  if (lock.lockHash !== baseline.collection.identity.dependencyLockHash)
    throw new Error('Node PR dependency lock differs from sealed base');
  const baselineDeps = baseline.collection.dependencies;
  if (!same(observedDependencyEvidence(root, Object.keys(baselineDeps), lock), baselineDeps))
    throw new Error('Node PR previously observed dependency bytes differ from sealed base');
  mkdirSync(out);
  const head = collectNodeProfile({ root, files: decision.files,
    out: join(out, 'collection'), config: baseline.config, runs: 2,
    nodePath, inputPolicy, expectedProducerHash,
    mode: decision.route === 'profile-full' ? 'full' : 'selected' });
  if (head.identity.inputManifestHash !== sha(JSON.stringify(git.inputManifest)) ||
      head.identity.dependencyLockHash !== baseline.collection.identity.dependencyLockHash ||
      head.identity.producerHash !== expectedProducerHash ||
      !same(head.runRows[0], head.runRows[1]))
    throw new Error('Node PR HEAD collection identity or repeated rows differ');
  if (Object.entries(head.dependencies).some(([path, hash]) => baselineDeps[path] !== hash))
    throw new Error('Node PR HEAD observed a new or changed dependency');
  let scope = { scope: 'none', sites: [], filtered: [], invalid: [], lineSides: {} };
  let mutation = null;
  if (!head.input.tests.some(row => row.status === 'failed')) {
    scope = nodeProfileMutationScope({ root, baseline, head, decision,
      nodePath, headManifest: git.inputManifest });
    if (scope.sites.length)
      mutation = runNodeProfileMutationBatch({ root, input: head.input,
        selectedMutants: scope.sites, out: join(out, 'mutation'), nodePath,
        inputPolicy, expectedProducerHash, expectedIdentity: head.identity,
        expectedDependencies: head.dependencies, maxSeconds: scope.maxSeconds });
  }
  const assessment = assessNodeProfileRequest({ baseline, head, decision,
    sites: scope.sites, mutation, lineSides: scope.lineSides });
  const after = assertExactGitHead({ root, baseCommit, inputPolicy });
  const afterLock = loadLockedDependencies(root);
  if (!same(after, git) || afterLock.lockHash !== lock.lockHash ||
      !same(observedDependencyEvidence(root, Object.keys(baselineDeps), afterLock), baselineDeps) ||
      !same(observedDependencyEvidence(root, Object.keys(head.dependencies), afterLock), head.dependencies) ||
      !same(nodeProfileRuntimeIdentity(nodePath), runtime) ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR HEAD, dependency, runtime or producer changed during request');
  const result = { spec: 'cupel-pr-result/1', kind: 'scoped-pr',
    profile: 'node-readonly-files-v2', wholeGuardPass: false,
    complete: !assessment.tests.failed.length,
    exit: assessment.exit, baseCommit, headCommit: git.commit,
    baselineHash: expectedBaselineHash, producerHash: expectedProducerHash,
    runtime, privacyPolicy: inputPolicy,
    route: decision.route, reason: decision.reason,
    changed: decision.changed, executedFiles: decision.files,
    unexecutedFiles: head.fullFiles.filter(file => !decision.files.includes(file)),
    headIdentity: head.identity,
    comparison: assessment, mutationScope: {
      kind: scope.scope, sites: scope.sites, filtered: scope.filtered,
      invalid: scope.invalid, lineSides: scope.lineSides ?? {} },
    mutation, costs: { requestMs: Math.round(performance.now() - started),
      collectionExecutionMs: head.attempts.reduce((sum, row) => sum + row.costs.executionMs, 0),
      mutation: mutation?.costs ?? null } };
  const diagnostics = validate(resultSchema, result);
  if (diagnostics.length)
    throw new Error(`Node PR result schema invalid: ${JSON.stringify(diagnostics)}`);
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`);
  if (bytes.length > (32 << 20)) throw new Error('Node PR result exceeds 32 MiB');
  assertPrivateOutputPaths(root, [out, resultPath]);
  writeFileSync(resultPath, bytes, { flag: 'wx', mode: 0o600 });
  return { kind: 'scoped-pr', exit: result.exit,
    result: { path: resultPath, sha256: sha(bytes), bytes: bytes.length },
    report: result };
}
