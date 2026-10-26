import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { digest, NODE_PROFILE, OPAQUE_NPMRC_POLICY, refuse } from '../s12b/evidence.mjs';
import { nodeVersion } from '../s12b/evidence-node-context.mjs';
import { observedDependencyEvidence } from '../s12b/node-profile/dependencies.mjs';
import { executeSelectedHead } from '../s16/capture.mjs';
import { selectVerifiedHead } from '../s16/selection.mjs';
import { headSnapshot } from '../s16/snapshot.mjs';
import { assessVerifiedHead } from '../s16/validation.mjs';
import { readArtifact } from './artifact.mjs';
import { completeHeadTrace } from './postprocess.mjs';
import { sealedProducerProof } from './producer.mjs';
import { discoverHeadTests } from './test-universe.mjs';
import { validateSealedBaseline } from './validation.mjs';

const allowed = new Set(['artifactPath', 'expectedArtifactHash', 'expectedBaseCommit',
  'expectedProducerHash', 'headRoot', 'nodePath', 'inputPolicy', 'out']);
const pin = value => /^sha256:[0-9a-f]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const testFile = path => /^tests\/(?:.+\.test\.[cm]?[jt]sx?|(?:.*\/)?test_.*\.py)$/.test(path);

/** Consume pinned historical baseline evidence; execute fresh isolated HEAD tests. */
export function runSealedSelectedHead(opts) {
  const started = performance.now();
  const timings = { totalMs: 0, sealedValidationMs: 0, headPreflightMs: 0,
    decisionMs: 0, captureMs: 0, postValidationMs: 0 };
  const counters = { baselineRootReads: 0, artifactReads: 0, headTestUniverseWalks: 0,
    headInputSnapshots: 0, selectedProcesses: 0 };
  let decision = null, capture = null, assessment = null;
  const finish = () => { timings.totalMs = Math.round(performance.now() - started);
    return { decision, capture, assessment, timings, counters }; };
  const deny = reason => { decision ??= refuse(reason); assessment = refuse(reason);
    return finish(); };
  if (!opts || typeof opts !== 'object' || Array.isArray(opts))
    return deny('S18 consume options missing');
  const unknown = Object.keys(opts).filter(key => !allowed.has(key));
  if (unknown.length) return deny(`S18 caller-supplied context or unsupported option: ${unknown.join(', ')}`);
  const { artifactPath, expectedArtifactHash, expectedBaseCommit,
    expectedProducerHash, headRoot, nodePath, inputPolicy, out } = opts;
  if (!artifactPath || !expectedBaseCommit || !headRoot || !nodePath || !inputPolicy ||
    !out || !pin(expectedArtifactHash) || !pin(expectedProducerHash))
    return deny('S18 explicit sealed artifact, independent pins, commit, HEAD, policy, Node and output required');
  try {
    const sealedStarted = performance.now();
    const producer = sealedProducerProof();
    if (producer.producerHash !== expectedProducerHash)
      return deny('S18 producer source differs from independent frozen pin');
    counters.artifactReads++;
    const artifact = readArtifact(artifactPath, expectedArtifactHash);
    const runtime = nodeVersion(nodePath);
    const baseline = validateSealedBaseline(artifact, { expectedBaseCommit,
      expectedProducerHash, producer: producer.producer, runtime, inputPolicy });
    if (sha(readFileSync(nodePath)) !== baseline.args.dependencyInstall.nodeBinary)
      return deny('S18 selected Node binary differs from sealed baseline installation');
    timings.sealedValidationMs = Math.round(performance.now() - sealedStarted);

    const preStarted = performance.now();
    counters.headTestUniverseWalks++;
    const fullFiles = discoverHeadTests(headRoot);
    if (!fullFiles.length) return deny('S18 HEAD has no supported test file inventory');
    counters.headInputSnapshots++;
    const pre = headSnapshot({ root: headRoot, files: fullFiles, version: runtime, inputPolicy });
    if (!same(fullFiles, Object.keys(pre.inventory).filter(testFile).sort()))
      return deny('S18 HEAD test universe changed before preflight snapshot');
    if (pre.runtimeHash !== baseline.args.environmentPolicy.runtimeHash ||
      !same(pre.environmentPolicy, baseline.args.environmentPolicy))
      return deny('S18 baseline runtime or environment policy differs');
    if (!same({ ...pre.config, files: baseline.args.config.files }, baseline.args.config))
      return deny('S18 baseline and HEAD config differs beyond test file universe');
    if (pre.dependencyLock.lockHash !== baseline.lock.lockHash ||
      !same(pre.dependencyLock.packages, baseline.lock.packages))
      return deny('S18 baseline and HEAD dependency lock or installation differs');
    const baselineDependencies = baseline.bundle.sidecar.dependencies.files;
    const preDependencies = observedDependencyEvidence(headRoot,
      Object.keys(baselineDependencies), pre.dependencyLock);
    if (!same(preDependencies, baselineDependencies))
      return deny('S18 baseline dependency bytes changed before selected-head execution');
    timings.headPreflightMs = Math.round(performance.now() - preStarted);

    const decisionStarted = performance.now();
    decision = selectVerifiedHead(baseline.bundle, pre);
    timings.decisionMs = Math.round(performance.now() - decisionStarted);
    if (decision.kind !== 'selected') {
      assessment = decision.kind === 'refuse' ? refuse(decision.reason) :
        { kind: 'not-run', reason: 'D16 full route requires a separate full oracle' };
      return finish();
    }
    if (inputPolicy === OPAQUE_NPMRC_POLICY &&
      baseline.bundle.sidecar.fullReferenceGuard?.mode !== 'privacy-guarded')
      return deny('S18 sealed baseline privacy guard proof differs');
    const headPolicy = { ...pre.environmentPolicy,
      runtimeHash: producer.producerHash, producer: producer.producer };
    const headEnvironmentPolicyHash = digest(headPolicy);
    const captureStarted = performance.now();
    capture = executeSelectedHead({ root: headRoot, files: decision.files,
      fullFiles, out, nodePath, pre,
      baselineConfigHash: baseline.bundle.sidecar.execution.configHash,
      headEnvironmentPolicyHash, producer: producer.producer,
      producerHash: producer.producerHash });
    counters.selectedProcesses = capture.timings.length;
    timings.captureMs = Math.round(performance.now() - captureStarted);

    const postStarted = performance.now();
    counters.headInputSnapshots++;
    const post = headSnapshot({ root: headRoot, files: fullFiles, version: runtime, inputPolicy });
    const postProducer = sealedProducerProof();
    if (postProducer.producerHash !== expectedProducerHash ||
      !same(postProducer.producer, producer.producer))
      return deny('S18 producer source changed during selected-head request');
    const postDependencies = completeHeadTrace({ capture, pre, post, headRoot,
      baselineDependencies, inputPolicy });
    assessment = assessVerifiedHead({ bundle: baseline.bundle, decision, capture,
      pre, post, postDependencies, producer: producer.producer,
      producerHash: producer.producerHash, headEnvironmentPolicyHash });
    timings.postValidationMs = Math.round(performance.now() - postStarted);
    return finish();
  } catch (error) { return deny(`S18 selected request refused: ${error.message}`); }
}
