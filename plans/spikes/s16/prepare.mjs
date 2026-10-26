import { join } from 'node:path';
import { captureNodeProfile } from '../s12b/node-profile/launch.mjs';
import { FROZEN_PROFILE_RUNTIME_HASH, makeNodeProfileBundle } from '../s12b/evidence-node-context.mjs';
import { verifyCollectorParity } from '../s12b/evidence.mjs';
import { saveJson, seal } from './artifacts.mjs';
import { assertFullCapture, assertSameRows } from './oracle.mjs';
import { cohesiveSelected, oldSelected, verifyMethod } from './methods.mjs';
import { currentProducerProof, EXPECTED_PRODUCER, withProducerProof } from './frozen-producer.mjs';
import { assertPinnedMetadata, baseCommit, baseRoot, cases, collectorInput,
  files, inputPolicy } from './fixture.mjs';

const EXPECTED_OLD_HASH =
  'sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b';

export function prepareRun({ runDir, nodePath }) {
  if (FROZEN_PROFILE_RUNTIME_HASH !== EXPECTED_OLD_HASH)
    throw new Error('trusted S12b reference profile changed from the validated real lane');
  withProducerProof(currentProducerProof(), EXPECTED_PRODUCER, () => {});
  const metadata = { baseline: assertPinnedMetadata(baseRoot) };
  for (const item of cases) metadata[item.name] = assertPinnedMetadata(item.root);
  const input = collectorInput();
  const baseline = captureNodeProfile({ root: baseRoot, files,
    out: join(runDir, 'baseline-profile'), nodePath, inputPolicy });
  const baselineRows = assertFullCapture(baseline, files, 0, 'S16 fresh baseline');
  const collectorParity = verifyCollectorParity(input.tests, baselineRows);
  if (collectorParity) throw new Error(`S16 actual collector parity: ${collectorParity}`);
  const { args: baselineArgs, bundle } = makeNodeProfileBundle({
    baseRoot, input, sidecar: baseline.sidecar, nodePath, baseCommit, inputPolicy });
  const validity = { oldProfileHash: EXPECTED_OLD_HASH, inputPolicy,
    baseCommit, metadata, baselineTests: baselineRows.length, collectorParity, cases: {} };
  const names = ['baseline-full.json', 'bundle.json', 'args.json', 'validity.json'];
  saveJson(runDir, 'baseline-full.json', baseline);
  saveJson(runDir, 'bundle.json', bundle);
  saveJson(runDir, 'args.json', baselineArgs);
  for (const item of cases) {
    const full = captureNodeProfile({ root: item.root, files,
      out: join(runDir, `${item.name}-full-profile`), nodePath, inputPolicy });
    const fullRows = assertFullCapture(full, files, item.failures, `${item.name} full oracle`);
    const old = oldSelected({ bundle, baselineArgs, caseName: item.name,
      nodePath, out: join(runDir, `${item.name}-old-initial`) });
    const candidate = cohesiveSelected({ bundle, baselineArgs, caseName: item.name,
      nodePath, out: join(runDir, `${item.name}-candidate-initial`) });
    const oldProof = verifyMethod(old, item.name, fullRows);
    const candidateProof = verifyMethod(candidate, item.name, fullRows);
    if (JSON.stringify(old.decision.files) !== JSON.stringify(candidate.decision.files))
      throw new Error(`${item.name}: candidate and old decisions differ`);
    assertSameRows(old.capture.selectedHead.rows, candidate.capture.selectedHead.rows,
      `${item.name} candidate/old outcomes`);
    validity.cases[item.name] = { fullTests: fullRows.length,
      failures: item.failures, oldProof, candidateProof,
      candidateProducer: candidate.capture.sidecar.execution.producer,
      candidateProducerHash: candidate.capture.sidecar.execution.profileRuntimeHash,
      oldInitialWallMs: old.wallMs, candidateInitialWallMs: candidate.wallMs };
    for (const [name, value] of [
      [`${item.name}-full.json`, full],
      [`${item.name}-old-initial.json`, old],
      [`${item.name}-candidate-initial.json`, candidate],
    ]) { saveJson(runDir, name, value); names.push(name); }
  }
  saveJson(runDir, 'validity.json', validity);
  seal(runDir, names);
  return validity;
}
