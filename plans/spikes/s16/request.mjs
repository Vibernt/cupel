import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest, NODE_PROFILE, OPAQUE_NPMRC_POLICY, refuse,
  validateBundle } from '../s12b/evidence.mjs';
import { nodeVersion } from '../s12b/evidence-node-context.mjs';
import { observedDependencyEvidence } from '../s12b/node-profile/dependencies.mjs';
import { executeSelectedHead } from './capture.mjs';
import { producerProof } from './producer.mjs';
import { selectVerifiedHead } from './selection.mjs';
import { headSnapshot } from './snapshot.mjs';
import { assessVerifiedHead } from './validation.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const allowed = new Set(['bundle', 'baselineArgs', 'baseRoot', 'headRoot', 'fullFiles',
  'inputPolicy', 'nodePath', 'out', 'expectedProducerHash']);
const timer = () => performance.now();

function selectedDependencyEvidence(observed, allPostEvidence, lock) {
  const roots = Object.keys(lock.packages).sort((a, b) => b.length - a.length);
  const needed = new Set();
  for (const path of observed) {
    if (!path.includes('node_modules/')) continue;
    const root = roots.find(key => path === `${key}/package.json` ||
      path.startsWith(`${key}/`));
    if (!root) continue;
    needed.add(path);
    needed.add(`${root}/package.json`);
  }
  return Object.fromEntries(Object.entries(allPostEvidence)
    .filter(([path]) => needed.has(path)));
}

/** Experimental single-request coordinator; no caller-supplied snapshot survives a call. */
export function runSelectedHeadRequest(opts) {
  const timings = { totalMs: 0, baselineValidationMs: 0, headPreflightMs: 0,
    decisionMs: 0, captureMs: 0, postValidationMs: 0 };
  const counters = { baselineInputSnapshots: 0, headInputSnapshots: 0,
    selectedProcesses: 0 };
  const started = timer();
  let decision = null, capture = null, assessment = null;
  const finish = () => {
    timings.totalMs = Math.round(timer() - started);
    return { decision, capture, assessment, timings, counters };
  };
  const deny = reason => { decision ??= refuse(reason); assessment = refuse(reason); return finish(); };
  if (!opts || typeof opts !== 'object' || Array.isArray(opts))
    return deny('S16 request options missing');
  const unknown = Object.keys(opts).filter(key => !allowed.has(key));
  if (unknown.length) return deny(`S16 caller-supplied context or unsupported option: ${unknown.join(', ')}`);
  const { bundle, baselineArgs, baseRoot, headRoot, fullFiles, inputPolicy,
    nodePath, out, expectedProducerHash } = opts;
  if (!bundle || !baselineArgs || !baseRoot || !headRoot || !out || !nodePath ||
    !Array.isArray(fullFiles) || !inputPolicy ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedProducerHash))
    return deny('S16 explicit bundle, roots, full files, policy, Node path, output and frozen producer pin are required');
  if (baselineArgs.baseRoot !== baseRoot || baselineArgs.inputPolicy !== inputPolicy ||
    baselineArgs.runner !== 'node' || baselineArgs.executionPolicy !== NODE_PROFILE ||
    baselineArgs.environmentPolicy?.runtimeHash !== bundle?.sidecar?.execution?.profileRuntimeHash)
    return deny('S16 baseline request policy or profile differs');
  if (new Set(fullFiles).size !== fullFiles.length ||
    !same([...fullFiles].sort(), bundle?.sidecar?.completion?.expectedFiles))
    return deny('S16 full file universe differs from verified baseline');
  const baseStarted = timer();
  counters.baselineInputSnapshots++;
  let baselineError;
  try { baselineError = validateBundle(bundle, baselineArgs); }
  catch (error) { baselineError = error.message; }
  timings.baselineValidationMs = Math.round(timer() - baseStarted);
  if (baselineError) return deny(`baseline: ${baselineError}`);
  if (bundle.sidecar.execution.mode !== 'baseline' ||
    bundle.sidecar.constrainedFull !== undefined ||
    bundle.sidecar.execution.profile !== NODE_PROFILE)
    return deny('S16 baseline profile identity or parity proof differs');
  if (!bundle.sidecar.dependencies?.files ||
    typeof bundle.sidecar.dependencies.files !== 'object')
    return deny('S16 baseline observed dependency evidence missing');
  try {
    const version = nodeVersion(nodePath);
    if (version !== baselineArgs.runtime || version !== baselineArgs.runnerVersion ||
      sha(readFileSync(nodePath)) !== baselineArgs.dependencyInstall.nodeBinary)
      return deny('S16 selected Node binary or version differs from baseline installation');
    const preStarted = timer();
    counters.headInputSnapshots++;
    const pre = headSnapshot({ root: headRoot, files: fullFiles, version, inputPolicy });
    if (bundle.sidecar.execution.profileRuntimeHash !== pre.runtimeHash ||
      !same(baselineArgs.environmentPolicy, pre.environmentPolicy))
      return deny('S16 baseline runtime or environment policy differs from executed hook');
    const { producer, producerHash } = producerProof(pre.runtimeHash);
    if (producerHash !== expectedProducerHash)
      return deny('S16 producer source differs from frozen acceptance pin');
    const headPolicy = { ...pre.environmentPolicy, runtimeHash: producerHash, producer };
    const headEnvironmentPolicyHash = digest(headPolicy);
    if (bundle.sidecar.execution.dependencyLockHash !== pre.dependencyLock.lockHash)
      return deny('baseline and head dependency lock identity differs');
    const baselineDependencies = bundle.sidecar.dependencies.files;
    const preDependencies = observedDependencyEvidence(headRoot,
      Object.keys(baselineDependencies), pre.dependencyLock);
    if (!same(preDependencies, baselineDependencies))
      return deny('baseline dependency bytes changed before selected-head execution');
    timings.headPreflightMs = Math.round(timer() - preStarted);

    const decisionStarted = timer();
    decision = selectVerifiedHead(bundle, pre);
    timings.decisionMs = Math.round(timer() - decisionStarted);
    if (decision.kind !== 'selected') {
      assessment = decision.kind === 'refuse' ? refuse(decision.reason) :
        { kind: 'not-run', reason: 'D16 full route requires a full oracle' };
      return finish();
    }
    if (!same(baselineArgs.config, pre.config))
      return deny('S16 selected head config differs from verified baseline');
    if (inputPolicy === OPAQUE_NPMRC_POLICY &&
      bundle.sidecar.fullReferenceGuard?.mode !== 'privacy-guarded')
      return deny('selected head baseline privacy guard proof differs');
    const captureStarted = timer();
    capture = executeSelectedHead({ root: headRoot, files: decision.files,
      fullFiles, out, nodePath, pre,
      baselineConfigHash: bundle.sidecar.execution.configHash,
      headEnvironmentPolicyHash, producer, producerHash });
    counters.selectedProcesses = capture.timings.length;
    timings.captureMs = Math.round(timer() - captureStarted);

    const postStarted = timer();
    counters.headInputSnapshots++;
    const post = headSnapshot({ root: headRoot, files: fullFiles, version, inputPolicy });
    const postProducer = producerProof(post.runtimeHash);
    if (!same(postProducer.producer, producer) ||
      postProducer.producerHash !== producerHash ||
      postProducer.producerHash !== expectedProducerHash)
      return deny('S16 producer source changed during selected-head request');
    const sidecar = capture.sidecar;
    for (const entry of Object.values(sidecar.files)) for (const path of entry.imports)
      if (/\.(?:ts|mts|cts)$/.test(path)) {
        if (!pre.manifest[path]) sidecar.global.unsupported.push(`missing-native-typescript-source:${path}`);
        else sidecar.nativeTypeScript.files[path] = pre.manifest[path];
      }
    if (!same(pre.manifest, post.manifest) ||
      pre.opaqueRootNpmrc !== post.opaqueRootNpmrc)
      sidecar.global.unsupported.push('changed-input-inventory');
    if (!same(pre.dependencyLock, post.dependencyLock))
      sidecar.global.unsupported.push('changed-dependency-lock');
    const observed = Object.values(sidecar.files).flatMap(entry => [
      ...entry.imports, ...entry.reads, ...entry.probes, ...entry.directories]);
    const postDependencies = observedDependencyEvidence(headRoot,
      [...new Set([...observed, ...Object.keys(baselineDependencies)])], post.dependencyLock);
    const postBaseline = Object.fromEntries(Object.entries(postDependencies)
      .filter(([path]) => Object.hasOwn(baselineDependencies, path)));
    if (!same(postBaseline, baselineDependencies))
      sidecar.global.unsupported.push('baseline-dependency-bytes-changed-during-run');
    sidecar.dependencies = { lockHash: pre.dependencyLock.lockHash,
      files: selectedDependencyEvidence(observed, postDependencies, post.dependencyLock) };
    if (Object.keys(sidecar.dependencies.files).some(path =>
      !Object.hasOwn(baselineDependencies, path)))
      sidecar.global.unsupported.push('new-dependency-observation');
    for (const entry of Object.values(sidecar.files)) {
      entry.capabilities.push('baseline-parity-bound');
      if (inputPolicy === OPAQUE_NPMRC_POLICY) entry.capabilities.push('baseline-privacy-bound');
    }
    assessment = assessVerifiedHead({ bundle, decision, capture, pre, post,
      postDependencies: sidecar.dependencies.files, producer, producerHash,
      headEnvironmentPolicyHash });
    timings.postValidationMs = Math.round(timer() - postStarted);
    return finish();
  } catch (error) { return deny(`S16 selected request refused: ${error.message}`); }
}
