import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { captureNodeProfile } from '../node-profile/launch.mjs';
import { runOpaqueFull } from '../node-profile/opaque-full.mjs';
import { FROZEN_PROFILE_RUNTIME_HASH, makeNodeProfileBundle, nodeProfilePolicy } from '../evidence-node-context.mjs';
import { selectS12b, assessHeadTrace } from '../selection.mjs';
import { verifyCollectorParity } from '../evidence.mjs';
import { assertCapture, assertRowsEqual, FILES, median, originCounts, pairOrder, resultRows } from './recheck-utils.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const project = resolve(here, '../../../../');
const scratch = join(project, '.scratch/s12b/real-lane');
const phase = process.argv[2];
if (!['pre', 'final'].includes(phase)) throw new Error('usage: node recheck.mjs pre|final');
const pairCount = phase === 'pre' ? 1 : 5;
const output = join(scratch, `provenance-${phase}-${FROZEN_PROFILE_RUNTIME_HASH.slice(7, 19)}`);
const nodePath = process.execPath;
const inputPolicy = 'express-root-npmrc-opaque-v1';
const profileRoot = join(project, 'plans/spikes/s12b/node-profile');
const baseRoot = join(scratch, 'express');
const baseCommit = '4ca3fa8701629a4eb27c76a69aa6d6e294290b40';
const cases = [
  { name: 'accessible', root: join(scratch, 'case-accessible'), expectedFailures: 4,
    changed: 'src/plugins/rehype-accessible-tables.mjs' },
  { name: 'code-tabs', root: join(scratch, 'case-code-tabs'), expectedFailures: 8,
    changed: 'src/plugins/remark-code-tabs.mjs' },
];
const fixedEnv = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' };
const now = () => Math.round(performance.now());
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function trackedRootMetadata(root) {
  const git = args => {
    const run = spawnSync('git', ['-C', root, ...args],
      { encoding: 'utf8', env: { ...fixedEnv, PATH: '/usr/bin:/bin:/opt/homebrew/bin',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 5000 });
    if (run.status !== 0 || run.error) throw new Error(`Git metadata query failed: ${args.join(' ')}`);
    return run.stdout.trim();
  };
  const commit = git(['rev-parse', 'HEAD']);
  const npmrcStage = git(['ls-files', '--stage', '--', '.npmrc']);
  if (commit !== baseCommit || !/^100644 [0-9a-f]{40} 0\t\.npmrc$/.test(npmrcStage))
    throw new Error('pinned public commit or tracked root .npmrc metadata differs');
  return { commit, npmrcStage };
}

function guardedFull({ root, name, pair, expectedRows }) {
  if (inputPolicy !== 'express-root-npmrc-opaque-v1') throw new Error('guarded full policy differs');
  const out = join(output, `${name}-${pair}-guarded-full`);
  mkdirSync(out, { recursive: true });
  const start = now();
  const run = runOpaqueFull({ nodePath, root, here: profileRoot, files: FILES, out, env: fixedEnv });
  if (run.result.error) throw run.result.error;
  if (run.proof.errors.length || run.proof.denials.length ||
    JSON.stringify(run.proof.finishedFiles) !== JSON.stringify(FILES))
    throw new Error(`${name}: incomplete privacy-guarded full reference`);
  const rows = resultRows(run.result.stdout, root);
  assertRowsEqual(rows, expectedRows, `${name} guarded full pair ${pair}`);
  const ms = now() - start;
  writeFileSync(join(out, 'runner.out'), `${run.result.stdout ?? ''}\n${run.result.stderr ?? ''}`);
  save(join(out, 'proof.json'), run.proof);
  return { ms, exit: run.result.status, rows: rows.length,
    failed: rows.filter(row => row.status === 'failed').length, privacyGuarded: true };
}

function selectedHead({ bundle, args, root, name, pair, changed, expectedRows }) {
  const totalStart = now();
  let step = now();
  const decision = selectS12b({ bundle, headRoot: root, ...args });
  const decisionMs = now() - step;
  if (decision.kind !== 'selected') throw new Error(`${name}: ${decision.kind}: ${decision.reason}`);
  if (JSON.stringify(decision.changed) !== JSON.stringify([changed]))
    throw new Error(`${name}: head change is not the one source fault`);
  step = now();
  const policy = nodeProfilePolicy({ root, files: FILES, version: args.runtime, inputPolicy });
  const policyMs = now() - step;
  step = now();
  const capture = captureNodeProfile({ mode: 'selected-head', root, files: decision.files,
    fullFiles: FILES, out: join(output, `${name}-${pair}-selected`), nodePath, inputPolicy,
    binding: { baselineConfigHash: bundle.sidecar.execution.configHash, baselineParity: true,
      baselinePrivacyGuardedFull: true,
      headConfigHash: policy.identity.configHash,
      environmentPolicyHash: policy.identity.environmentPolicyHash,
      dependencyLockHash: policy.identity.dependencyLockHash,
      profileRuntimeHash: policy.identity.profileRuntimeHash,
      dependencyEvidence: bundle.sidecar.dependencies.files } });
  const captureMs = now() - step;
  step = now();
  const trace = assessHeadTrace({ ...args, ...policy, decision, headRoot: root,
    sidecar: capture.sidecar, bundle, mode: 'selected-head' });
  const traceMs = now() - step;
  const ms = now() - totalStart;
  save(join(output, `${name}-${pair}-selected.json`), { decision, capture, trace });
  if (trace.kind !== 'accepted' || capture.ordinaryFull !== null ||
    capture.constrainedFull.parity !== null || !capture.selectedHead)
    throw new Error(`${name}: selected-head trace refused or ran an ordinary oracle: ${trace.reason}`);
  const filtered = expectedRows.filter(row => decision.files.includes(row.file));
  assertRowsEqual(capture.selectedHead.rows, filtered, `${name} selected-head pair ${pair}`);
  return { ms, decisionMs, policyMs, captureMs, traceMs, decision,
    selectedRows: capture.selectedHead.rows.length,
    failed: capture.selectedHead.rows.filter(row => row.status === 'failed').length,
    ordinaryInCapture: capture.ordinaryFull !== null,
    denials: capture.sidecar.denials,
    unsupported: capture.sidecar.global.unsupported };
}

function fullProfile(root, label, failures) {
  const start = now();
  const capture = captureNodeProfile({ root, files: FILES,
    out: join(output, `${label}-full`), nodePath, inputPolicy });
  const wallMs = now() - start;
  assertCapture(capture, FILES, failures, label);
  save(join(output, `${label}-full.json`), { wallMs, capture });
  return { capture, wallMs };
}

function main() {
  mkdirSync(output, { recursive: true });
  const tracked = Object.fromEntries([['baseline', baseRoot],
    ...cases.map(item => [item.name, item.root])].map(([name, root]) =>
    [name, trackedRootMetadata(root)]));
  const input = JSON.parse(readFileSync(join(scratch, 'collector-input.json'), 'utf8'));
  if (input.tests.length !== 65 || JSON.stringify([...new Set(input.tests.map(test => test.file))].sort()) !==
    JSON.stringify(FILES)) throw new Error('collector inventory is not the original 65 tests / four files');
  const baseline = fullProfile(baseRoot, 'baseline', 0);
  const collectorParity = verifyCollectorParity(input.tests, baseline.capture.ordinaryFull.rows);
  if (collectorParity) throw new Error(`baseline collector parity: ${collectorParity}`);
  const { args, bundle } = makeNodeProfileBundle({ baseRoot, input,
    sidecar: baseline.capture.sidecar, nodePath, baseCommit, inputPolicy });
  save(join(output, 'bundle.json'), bundle);
  const summary = { phase, runtimeHash: FROZEN_PROFILE_RUNTIME_HASH, inputPolicy, baseCommit,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    tracked,
    baseline: { wallMs: baseline.wallMs, ordinaryRows: baseline.capture.ordinaryFull.rows.length,
      collectorParity, originCounts: originCounts(baseline.capture.sidecar) }, cases: {} };
  for (const item of cases) {
    const full = fullProfile(item.root, item.name, item.expectedFailures);
    const initial = selectedHead({ bundle, args, root: item.root,
      name: item.name, pair: 'initial', changed: item.changed,
      expectedRows: full.capture.ordinaryFull.rows });
    const pairs = [];
    for (let pair = 1; pair <= pairCount; pair++) {
      const methods = pairOrder(pair);
      const result = { pair, order: methods };
      for (const method of methods) result[method] = method === 'full' ?
        guardedFull({ root: item.root, name: item.name, pair, expectedRows: full.capture.ordinaryFull.rows }) :
        selectedHead({ bundle, args, root: item.root, name: item.name, pair,
          changed: item.changed, expectedRows: full.capture.ordinaryFull.rows });
      pairs.push(result);
      appendFileSync(join(output, 'timing-results.jsonl'), `${JSON.stringify({ case: item.name, ...result })}\n`);
    }
    summary.cases[item.name] = { fullProfileWallMs: full.wallMs,
      fullFailures: item.expectedFailures,
      initialDecision: initial.decision,
      selectedFiles: initial.decision.files.length,
      strictSubset: initial.decision.files.length < FILES.length,
      initialSelectionWallMs: initial.ms,
      fullMedianMs: median(pairs.map(pair => pair.full.ms)),
      selectedMedianMs: median(pairs.map(pair => pair.selected.ms)), pairs };
  }
  save(join(output, 'summary.json'), summary);
  process.stdout.write(`${JSON.stringify({ output, baseline: summary.baseline,
    cases: Object.fromEntries(Object.entries(summary.cases).map(([name, item]) => [name,
      { fullFailures: item.fullFailures, selectedFiles: item.selectedFiles,
        strictSubset: item.strictSubset, fullMedianMs: item.fullMedianMs,
        selectedMedianMs: item.selectedMedianMs }])) }, null, 2)}\n`);
}

main();
