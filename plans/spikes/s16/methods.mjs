import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { captureNodeProfile } from '../s12b/node-profile/launch.mjs';
import { runOpaqueFull } from '../s12b/node-profile/opaque-full.mjs';
import { nodeProfilePolicy } from '../s12b/evidence-node-context.mjs';
import { selectS12b, assessHeadTrace } from '../s12b/selection.mjs';
import { runSelectedHeadRequest } from './request.mjs';
import { EXPECTED_PRODUCER, withProducerProof } from './frozen-producer.mjs';
import { assertSelectedCatches, reporterRows } from './oracle.mjs';
import { cases, files, fixedEnv, inputPolicy, project } from './fixture.mjs';

const profileRoot = join(project, 'plans/spikes/s12b/node-profile');
const ms = start => Math.round(performance.now() - start);
const target = name => {
  const item = cases.find(entry => entry.name === name);
  if (!item) throw new Error(`unknown real fault case: ${name}`);
  return item;
};

export function oldSelected({ bundle, baselineArgs, caseName, nodePath, out }) {
  const item = target(caseName);
  const start = performance.now();
  const step = {};
  let mark = performance.now();
  const decision = selectS12b({ bundle, headRoot: item.root, ...baselineArgs });
  step.decisionMs = ms(mark);
  if (decision.kind !== 'selected') throw new Error(`old selection: ${decision.reason}`);
  mark = performance.now();
  const policy = nodeProfilePolicy({ root: item.root, files, version: baselineArgs.runtime, inputPolicy });
  step.policyMs = ms(mark);
  mark = performance.now();
  const capture = captureNodeProfile({ mode: 'selected-head', root: item.root,
    files: decision.files, fullFiles: files, out, nodePath, inputPolicy,
    binding: { baselineConfigHash: bundle.sidecar.execution.configHash, baselineParity: true,
      baselinePrivacyGuardedFull: true, headConfigHash: policy.identity.configHash,
      environmentPolicyHash: policy.identity.environmentPolicyHash,
      dependencyLockHash: policy.identity.dependencyLockHash,
      profileRuntimeHash: policy.identity.profileRuntimeHash,
      dependencyEvidence: bundle.sidecar.dependencies.files } });
  step.captureMs = ms(mark);
  mark = performance.now();
  const assessment = assessHeadTrace({ ...baselineArgs, ...policy, decision,
    headRoot: item.root, sidecar: capture.sidecar, bundle, mode: 'selected-head' });
  step.validationMs = ms(mark);
  const wallMs = ms(start);
  return { method: 'old', decision, capture, assessment, wallMs, step };
}

export function cohesiveSelected({ bundle, baselineArgs, caseName, nodePath, out }) {
  const item = target(caseName);
  const totalStart = performance.now();
  if (!EXPECTED_PRODUCER?.producerHash) throw new Error('S16 frozen producer pin missing');
  const result = runSelectedHeadRequest({ bundle, baselineArgs,
    baseRoot: baselineArgs.baseRoot, headRoot: item.root, fullFiles: files,
    inputPolicy, expectedProducerHash: EXPECTED_PRODUCER.producerHash,
    nodePath, out });
  const apiMs = ms(totalStart);
  if (result.capture)
    withProducerProof({ producer: result.capture.sidecar.execution.producer,
      producerHash: result.capture.sidecar.execution.profileRuntimeHash },
    EXPECTED_PRODUCER, () => {});
  return { method: 'candidate', ...result, wallMs: ms(totalStart), apiMs };
}

export function guardedFull({ caseName, nodePath, out }) {
  const item = target(caseName);
  mkdirSync(out, { recursive: true });
  const start = performance.now();
  const run = runOpaqueFull({ nodePath, root: item.root, here: profileRoot,
    files, out, env: fixedEnv });
  if (run.result.error) throw run.result.error;
  const rows = reporterRows(run.result.stdout, item.root, files);
  const wallMs = ms(start);
  writeFileSync(join(out, 'runner.out'), `${run.result.stdout ?? ''}\n${run.result.stderr ?? ''}`);
  return { method: 'full', rows, proof: run.proof, exit: run.result.status,
    wallMs, processMs: run.ms };
}

export function verifyMethod(result, caseName, fullRows) {
  const item = target(caseName);
  if (result.method === 'full') {
    if (result.proof.mode !== 'privacy-guarded' || result.proof.errors.length ||
      result.proof.denials.length || JSON.stringify(result.proof.finishedFiles) !== JSON.stringify(files))
      throw new Error('privacy-guarded full reference incomplete');
    const summary = assertSelectedCatches(fullRows, result.rows, files, files, item.failures);
    if (result.exit !== 1) throw new Error('fault full oracle did not fail');
    return summary;
  }
  if (result.decision?.kind !== 'selected' || result.assessment?.kind !== 'accepted' ||
    result.capture?.ordinaryFull !== null || !result.capture?.selectedHead ||
    result.capture.sidecar.denials.length || result.capture.sidecar.global.unsupported.length ||
    result.capture.sidecar.completion.errors.length)
    throw new Error(`${result.method}: selected head refused or incomplete`);
  if (result.decision.files.length !== item.selectedFiles ||
    JSON.stringify(result.decision.changed) !== JSON.stringify([item.changed]))
    throw new Error(`${result.method}: changed-source decision differs`);
  if (result.method === 'candidate' &&
    (result.counters?.baselineInputSnapshots !== 1 ||
      result.counters.headInputSnapshots !== 2 ||
      result.counters.selectedProcesses !== item.selectedFiles))
    throw new Error('candidate snapshot/process counters differ');
  return assertSelectedCatches(fullRows, result.capture.selectedHead.rows,
    result.decision.files, files, item.failures);
}
