import { performance } from 'node:perf_hooks';
import { runSealedSelectedHead } from '../request.mjs';
import { runSelectedHeadRequest } from '../../s16/request.mjs';
import { guardedFull, verifyMethod } from '../../s16/methods.mjs';
import { EXPECTED_PRODUCER } from '../../s16/frozen-producer.mjs';
import { assertSameRows, assertSelectedCatches } from '../../s16/oracle.mjs';
import { baseRoot, cases, EXPECTED_S18_PRODUCER, files, inputPolicy } from './fixture.mjs';

const itemOf = name => {
  const item = cases.find(row => row.name === name);
  if (!item) throw new Error(`unknown real fault case: ${name}`);
  return item;
};

export function executeMethod({ method, caseName, out, nodePath, prepared, s16Context }) {
  const item = itemOf(caseName);
  const expectedRows = prepared.fullOracles[caseName].rows;
  if (method === 's16') {
    const started = performance.now();
    const result = runSelectedHeadRequest({ ...s16Context, baseRoot,
      headRoot: item.root, fullFiles: files, inputPolicy,
      expectedProducerHash: EXPECTED_PRODUCER.producerHash, nodePath, out });
    const wallMs = performance.now() - started;
    const proof = verifyMethod({ method:'candidate', ...result }, caseName, expectedRows);
    return { method, wallMs, proof, ...result };
  }
  if (method === 's18') {
    const started = performance.now();
    const result = runSealedSelectedHead({
      artifactPath: prepared.preparation.artifactPath,
      expectedArtifactHash: prepared.preparation.artifactHash,
      expectedBaseCommit: prepared.baseCommit,
      expectedProducerHash: EXPECTED_S18_PRODUCER,
      headRoot: item.root, nodePath, inputPolicy, out,
    });
    const wallMs = performance.now() - started;
    if (result.decision?.kind !== 'selected' || result.assessment?.kind !== 'accepted' ||
      result.capture?.ordinaryFull !== null || !result.capture?.selectedHead ||
      result.decision.files.length !== item.selectedFiles ||
      result.counters?.baselineRootReads !== 0 || result.counters.artifactReads !== 1 ||
      result.counters.headTestUniverseWalks !== 1 || result.counters.headInputSnapshots !== 2 ||
      result.counters.selectedProcesses !== item.selectedFiles)
      throw new Error(`${caseName}: S18 selected request refused or incomplete: ${result.assessment?.reason ?? result.decision?.reason}`);
    const proof = assertSelectedCatches(expectedRows, result.capture.selectedHead.rows,
      result.decision.files, files, item.failures);
    return { method, wallMs, proof, ...result };
  }
  if (method === 'full') {
    const result = guardedFull({ caseName, nodePath, out });
    const proof = verifyMethod(result, caseName, expectedRows);
    assertSameRows(result.rows, expectedRows, `${caseName} repeated full oracle`);
    return { method, wallMs: result.wallMs, proof, rows: result.rows,
      privacy: result.proof, exit: result.exit, processMs: result.processMs };
  }
  throw new Error(`unknown S18 method: ${method}`);
}

export function assertEquivalentSelections(s16, s18, label) {
  if (JSON.stringify(s16.decision.files) !== JSON.stringify(s18.decision.files))
    throw new Error(`${label}: S16/S18 selected files differ`);
  assertSameRows(s16.capture.selectedHead.rows, s18.capture.selectedHead.rows,
    `${label}: S16/S18 selected rows`);
}
