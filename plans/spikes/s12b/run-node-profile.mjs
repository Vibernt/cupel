#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { baseFiles, cases, inject, writeFiles } from '../s12/fixtures.mjs';
import { normalizeInputPolicy, OPAQUE_NPMRC_POLICY, safeFileInventory } from './evidence-base.mjs';
import { captureNodeProfile } from './node-profile/launch.mjs';
import { digest, verifyCollectorParity, verifyRunParity } from './evidence.mjs';
import { makeNodeProfileBundle, nodeProfilePolicy, nodeVersion } from './evidence-node-context.mjs';
import { assessHeadTrace, selectS12b } from './selection.mjs';
import { collect, execute } from './run-execute.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const probeRoot = join(repo, 'plans/spikes/s12b/node-profile');
const policyArg = process.argv.slice(2).find(arg => arg.startsWith('--input-policy='));
const inputPolicy = normalizeInputPolicy(policyArg?.slice('--input-policy='.length));
const nodeArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const nodePath = nodeArg ? resolve(nodeArg) : process.execPath;
const version = nodeVersion(nodePath);
if (version !== process.versions.node)
  throw new Error('run the orchestration script with the same Node binary used by the profile and collector');
const scratch = join(repo, '.scratch/s12b/node-profile-orchestration', version, inputPolicy);

const allTests = root => Object.keys(safeFileInventory(root, { inputPolicy }))
  .filter(path => /^tests\/.+\.test\.[cm]?js$/.test(path)).sort();
const outcome = rows => rows.some(row => row.status === 'failed') ? 'fail' :
  rows.length && rows.every(row => ['passed', 'skipped'].includes(row.status)) ? 'pass' : 'error';
const unacceptable = sidecar => [...sidecar.global.unsupported,
  ...Object.values(sidecar.files).flatMap(row => row.unsupported)];

function runCapture(root, files, out) {
  const policy = nodeProfilePolicy({ root, files, version, inputPolicy });
  const capture = captureNodeProfile({ mode: 'baseline', root, files, out, nodePath,
    inputPolicy, binding: policy.identity });
  if (inputPolicy === OPAQUE_NPMRC_POLICY && capture.ordinaryFull?.privacyGuarded !== true)
    return { capture, error: 'opaque ordinary full lacked privacy-guarded execution proof', policy };
  const parityError = verifyRunParity(capture.ordinaryFull.rows, capture.constrainedFull.rows);
  if (parityError || capture.constrainedFull.parity !== true) return { capture,
    error: parityError ?? 'ordinary and constrained full parity differs', policy };
  const ordinaryFailed = capture.ordinaryFull.rows.some(row => row.status === 'failed');
  if ((capture.ordinaryFull.exit === 0) === ordinaryFailed)
    return { capture, error: 'ordinary full exit differs from reported test statuses', policy };
  for (const timing of capture.timings) {
    const failed = capture.constrainedFull.rows.some(row => row.file === timing.file && row.status === 'failed');
    if (timing.exit == null || (timing.exit === 0) === failed)
      return { capture, error: `constrained exit differs from reported test statuses: ${timing.file}`, policy };
  }
  return { capture, error: null, policy };
}

function runSelectedCapture(root, files, fullFiles, out, bundle) {
  const policy = nodeProfilePolicy({ root, files: fullFiles, version, inputPolicy });
  const baseline = bundle.sidecar;
  const binding = { baselineConfigHash: baseline.execution.configHash, baselineParity: true,
    ...(inputPolicy === OPAQUE_NPMRC_POLICY ? { baselinePrivacyGuardedFull: true } : {}),
    headConfigHash: policy.identity.configHash,
    environmentPolicyHash: policy.identity.environmentPolicyHash,
    dependencyLockHash: policy.identity.dependencyLockHash,
    profileRuntimeHash: policy.identity.profileRuntimeHash,
    dependencyEvidence: baseline.dependencies.files };
  const capture = captureNodeProfile({ mode: 'selected-head', root, files, fullFiles, out,
    nodePath, inputPolicy, binding });
  if (capture.ordinaryFull !== null || !capture.selectedHead ||
    capture.constrainedFull.parity !== null)
    return { capture, policy, error: 'selected head performed an unexpected full parity run' };
  for (const timing of capture.timings) {
    const failed = capture.selectedHead.rows.some(row => row.file === timing.file && row.status === 'failed');
    if (timing.exit == null || (timing.exit === 0) === failed)
      return { capture, policy, error: `selected exit differs from reported statuses: ${timing.file}` };
  }
  return { capture, policy, error: null };
}

async function main() {
  mkdirSync(scratch, { recursive: true });
  const baseRoot = mkdtempSync(join(scratch, 'base-'));
  writeFiles(baseRoot, baseFiles('node'));
  if (inputPolicy === OPAQUE_NPMRC_POLICY)
    writeFileSync(join(baseRoot, '.npmrc'), 'dummy fixture only; never read\n');
  const normal = execute('node', baseRoot, [], nodePath);
  writeFileSync(join(scratch, 'baseline-ordinary.log'), normal.output);
  if (normal.outcome !== 'pass') throw new Error(`ordinary baseline ${normal.outcome}`);
  const baseCapture = runCapture(baseRoot, allTests(baseRoot), join(scratch, 'baseline-capture'));
  const input = await collect('node', baseRoot);
  writeFileSync(join(scratch, 'baseline-input.json'), JSON.stringify(input, null, 2) + '\n');
  let args; let bundle; let baselineRefusal = baseCapture.error;
  if (!baselineRefusal) baselineRefusal = verifyCollectorParity(input.tests, baseCapture.capture.ordinaryFull.rows);
  if (!baselineRefusal && ![version, `v${version}`].includes(input.runtime?.version))
    baselineRefusal = 'collector input runtime differs from Node profile';
  if (!baselineRefusal && baseCapture.capture.ordinaryFull.exit !== 0)
    baselineRefusal = 'profile ordinary full baseline failed';
  if (!baselineRefusal) {
    try { ({ args, bundle } = makeNodeProfileBundle({ baseRoot, input,
      sidecar: baseCapture.capture.sidecar, nodePath, inputPolicy,
      baseCommit: `scratch-tree:${digest(safeFileInventory(baseRoot, { inputPolicy }))}` })); }
    catch (error) { baselineRefusal = error.message; }
  }
  const records = [{ phase: 'baseline', runtime: version, inputPolicy,
    normalWallMs: normal.wallMs,
    profileOrdinaryWallMs: baseCapture.capture.ordinaryFull.ms,
    profileCaptureWallMs: baseCapture.capture.timings.reduce((sum, row) => sum + row.ms, 0),
    fullParity: !baseCapture.error, baselineRefusal,
    unsupported: unacceptable(baseCapture.capture.sidecar),
    tests: input.tests.length, files: allTests(baseRoot).length }];
  for (const item of cases) {
    const headRoot = mkdtempSync(join(scratch, `${item.name}-`));
    cpSync(baseRoot, headRoot, { recursive: true,
      filter: path => !relative(baseRoot, path).split('/').some(part =>
        ['node_modules', '.scratch', '__pycache__', '.pytest_cache'].includes(part)) });
    inject(headRoot, 'node', item.name);
    const oracle = execute('node', headRoot, [], nodePath);
    writeFileSync(join(scratch, `${item.name}-ordinary.log`), oracle.output);
    let caseBundle = bundle;
    if (bundle && item.name === 'stale-baseline') caseBundle = { ...bundle,
      binding: { ...bundle.binding, tree: 'stale' } };
    if (bundle && item.name === 'corrupt-baseline') caseBundle = { ...bundle,
      core: { ...bundle.core, input: { ...bundle.core.input, tests: [] } } };
    let decision = baselineRefusal ? { kind: 'refuse', reason: baselineRefusal, files: [] } :
      selectS12b({ ...args, headRoot, bundle: caseBundle });
    if (args && digest(safeFileInventory(probeRoot)) !== digest(args.probe.files))
      decision = { kind: 'refuse', reason: 'probe source changed since baseline', files: [] };
    let headFull; let selected;
    if (decision.kind === 'selected') {
      try {
        headFull = runCapture(headRoot, allTests(headRoot), join(scratch, `${item.name}-full-capture`));
        if (headFull.error) decision = { kind: 'refuse', reason: `head full parity: ${headFull.error}`, files: [] };
        else {
          const fullDecision = { kind: 'full', files: allTests(headRoot) };
          const fullTrace = assessHeadTrace({ ...args, ...headFull.policy, headRoot, decision: fullDecision,
            sidecar: headFull.capture.sidecar });
          if (fullTrace.kind === 'refuse') decision = fullTrace;
        }
        if (decision.kind === 'selected') {
          selected = runSelectedCapture(headRoot, decision.files, allTests(headRoot),
            join(scratch, `${item.name}-selected-capture`), bundle);
          if (selected.error) decision = { kind: 'refuse', reason: `selected parity: ${selected.error}`, files: [] };
          else {
            const trace = assessHeadTrace({ ...args, ...selected.policy, headRoot, decision,
              sidecar: selected.capture.sidecar, bundle, mode: 'selected-head' });
            if (trace.kind === 'refuse') decision = trace;
          }
        }
      } catch (error) { decision = { kind: 'refuse', reason: `head profile: ${error.message}`, files: [] }; }
    }
    const selectedOutcome = selected?.capture?.selectedHead ? outcome(selected.capture.selectedHead.rows) : null;
    records.push({ case: item.name, expectedOracle: item.oracle, oracle: oracle.outcome,
      oracleWallMs: oracle.wallMs, oracleMismatch: oracle.outcome !== item.oracle,
      expectedDecision: item.expect, decision: decision.kind, reason: decision.reason,
      selectedFiles: decision.files, selected: selectedOutcome,
      fullParity: headFull ? !headFull.error : null,
      selectedBound: selected ? !selected.error : null,
      strictSubset: decision.kind === 'selected' && decision.files.length < allTests(headRoot).length,
      falseGreen: decision.kind === 'selected' && oracle.outcome === 'fail' && selectedOutcome === 'pass' });
    rmSync(headRoot, { recursive: true, force: true });
  }
  writeFileSync(join(scratch, 'results.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const summary = { runtime: version, inputPolicy, cases: cases.length,
    oracleMismatches: records.filter(row => row.oracleMismatch).length,
    decisionMismatches: records.filter(row => row.expectedDecision && row.decision !== row.expectedDecision).length,
    selectedOutcomeMismatches: records.filter(row => row.decision === 'selected' &&
      row.selected !== row.oracle).length,
    oracleFaults: records.filter(row => row.oracle === 'fail').length,
    selected: records.filter(row => row.decision === 'selected').length,
    refusals: records.filter(row => row.decision === 'refuse').length,
    strictSubsets: records.filter(row => row.strictSubset).length,
    changedStrictSubsets: records.filter(row => row.strictSubset && row.case !== 'clean').length,
    falseGreens: records.filter(row => row.falseGreen).length,
    sourcePin: records.find(row => row.case === 'source-text-pin'), baselineRefusal };
  console.log(JSON.stringify(summary));
  if (summary.oracleMismatches || summary.decisionMismatches || summary.selectedOutcomeMismatches ||
    summary.falseGreens || !summary.changedStrictSubsets ||
    summary.sourcePin?.decision !== 'selected' || summary.sourcePin?.selected !== 'fail') process.exitCode = 1;
}

await main();
