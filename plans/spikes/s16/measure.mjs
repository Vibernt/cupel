import { join } from 'node:path';
import { FROZEN_PROFILE_RUNTIME_HASH } from '../s12b/evidence-node-context.mjs';
import { loadSealed, saveJson, seal } from './artifacts.mjs';
import { cases, files } from './fixture.mjs';
import { cohesiveSelected, guardedFull, oldSelected, verifyMethod } from './methods.mjs';
import { assertFullCapture, assertSameRows } from './oracle.mjs';
import { alternatingOrder, performanceGate } from './schedule.mjs';
import { currentProducerProof, EXPECTED_PRODUCER, withProducerProof } from './frozen-producer.mjs';

const EXPECTED_OLD_HASH =
  'sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b';
const methods = { old: oldSelected, candidate: cohesiveSelected, full: guardedFull };

function sourceEvidence(saved) {
  if (FROZEN_PROFILE_RUNTIME_HASH !== EXPECTED_OLD_HASH ||
    saved['validity.json']?.oldProfileHash !== EXPECTED_OLD_HASH)
    throw new Error('S16 fresh baseline profile source differs');
  if (saved['bundle.json']?.binding?.baseCommit !== saved['validity.json'].baseCommit)
    throw new Error('S16 saved pinned baseline differs');
  return { bundle: saved['bundle.json'], baselineArgs: saved['args.json'] };
}

function runOne({ runDir, nodePath, caseName, method, label, context, fullRows, validity }) {
  const out = join(runDir, label);
  const result = methods[method]({ ...context, caseName, nodePath, out });
  const proof = verifyMethod(result, caseName, fullRows);
  if (method === 'candidate') {
    const expected = validity.cases[caseName];
    if (result.capture.sidecar.execution.profileRuntimeHash !== expected.candidateProducerHash ||
      JSON.stringify(result.capture.sidecar.execution.producer) !==
        JSON.stringify(expected.candidateProducer))
      throw new Error('S16 coordinator producer changed after validity capture');
  }
  const name = `${label}.json`;
  return { name, result, proof };
}

function paired({ runDir, nodePath, item, comparison, context, fullRows, validity, names }) {
  const pairRows = [];
  for (let pair = 1; pair <= 5; pair++) {
    const order = alternatingOrder(pair, ...comparison);
    const runs = {};
    const evidence = [];
    for (const method of order) {
      const label = `${item.name}-${comparison.join('-')}-${pair}-${method}`;
      const outcome = runOne({ runDir, nodePath, caseName: item.name, method,
        label, context, fullRows, validity });
      names.push(outcome.name);
      evidence.push(outcome);
      runs[method] = outcome.result;
    }
    if (runs.old && runs.candidate) {
      if (JSON.stringify(runs.old.decision.files) !== JSON.stringify(runs.candidate.decision.files))
        throw new Error(`${item.name}: old and candidate selection differ in timing pair`);
      assertSameRows(runs.old.capture.selectedHead.rows,
        runs.candidate.capture.selectedHead.rows, `${item.name} paired outcomes`);
    }
    for (const outcome of evidence)
      saveJson(runDir, outcome.name, { result: outcome.result, proof: outcome.proof });
    pairRows.push({ pair, order,
      ...Object.fromEntries(comparison.map(method => [method, runs[method].wallMs])) });
  }
  return pairRows;
}

export function measureRun({ runDir, nodePath }) {
  const saved = loadSealed(runDir);
  withProducerProof(currentProducerProof(), EXPECTED_PRODUCER, () => {});
  const context = sourceEvidence(saved);
  const validity = saved['validity.json'];
  const rawNames = Object.keys(saved);
  const summary = { version: 's16-measurement/1', oldProfileHash: EXPECTED_OLD_HASH,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    comparisons: {}, setup: { baselineAndFaultProfiles: 'stored separately in sealed validity evidence' } };
  for (const item of cases) {
    const fullRows = assertFullCapture(saved[`${item.name}-full.json`],
      files, item.failures, `${item.name} saved full oracle`);
    const warmups = [];
    for (const method of ['old', 'candidate', 'full']) {
      const result = runOne({ runDir, nodePath, caseName: item.name, method,
        label: `${item.name}-warmup-${method}`, context, fullRows, validity });
      rawNames.push(result.name);
      saveJson(runDir, result.name, { result: result.result, proof: result.proof });
      warmups.push({ method, wallMs: result.result.wallMs });
    }
    const oldCandidate = paired({ runDir, nodePath, item,
      comparison: ['old', 'candidate'], context, fullRows, validity, names: rawNames });
    const candidateFull = paired({ runDir, nodePath, item,
      comparison: ['candidate', 'full'], context, fullRows, validity, names: rawNames });
    summary.comparisons[item.name] = { warmups, oldCandidate, candidateFull,
      gate: performanceGate(oldCandidate, candidateFull),
      fullOracleFailures: item.failures, selectedFiles: item.selectedFiles };
  }
  saveJson(runDir, 'timing-summary.json', summary);
  seal(runDir, [...rawNames, 'timing-summary.json']);
  return summary;
}
