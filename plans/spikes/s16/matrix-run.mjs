#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync,
  writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { baseFiles, cases, inject, writeFiles } from '../s12/fixtures.mjs';
import { safeFileInventory, normalizeInputPolicy,
  OPAQUE_NPMRC_POLICY } from '../s12b/evidence-base.mjs';
import { collect } from '../s12b/run-execute.mjs';
import { digest, verifyCollectorParity } from '../s12b/evidence.mjs';
import { makeNodeProfileBundle, nodeVersion } from '../s12b/evidence-node-context.mjs';
import { selectS12b } from '../s12b/selection.mjs';
import { EXPECTED_PRODUCER, currentProducerProof, withProducerProof } from './frozen-producer.mjs';
import { outcome, compareDecision, compareSelected, summarize } from './matrix-support.mjs';
import { assertSameRows } from './oracle.mjs';
import { fullOracle, selectedOld, verifiedCapture } from './matrix-capture.mjs';
import { runSelectedHeadRequest } from './request.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const allowedRawParent = join(repo, '.scratch/s16/oracle');
const [nodePathArg, policyArg, rawArg] = process.argv.slice(2);
if (!nodePathArg || !policyArg || !rawArg)
  throw new Error('usage: node matrix-run.mjs /absolute/node strict-v1|express-root-npmrc-opaque-v1 /absolute/.scratch/s16/oracle/unique-run');
const nodePath = resolve(nodePathArg);
const inputPolicy = normalizeInputPolicy(policyArg);
const version = nodeVersion(nodePath);
if (realpathSync(process.execPath) !== realpathSync(nodePath) ||
  process.versions.node !== version)
  throw new Error('matrix orchestration must run with the selected exact Node binary');
const rawRoot = resolve(rawArg);
if (dirname(rawRoot) !== allowedRawParent || existsSync(rawRoot))
  throw new Error('S16 matrix raw directory must be a new direct oracle child');
if (Buffer.byteLength(basename(rawRoot)) > 12)
  throw new Error('S16 matrix raw name exceeds 12 bytes; Node profile TMPDIR must stay short');
mkdirSync(rawRoot, { recursive: true });
const save = (name, value) => writeFileSync(join(rawRoot, name),
  JSON.stringify(value, null, 2) + '\n');
const allTests = root => Object.keys(safeFileInventory(root, { inputPolicy }))
  .filter(path => /^tests\/.+\.test\.[cm]?js$/.test(path)).sort();

async function main() {
  withProducerProof(currentProducerProof(), EXPECTED_PRODUCER, () => {});
  const savedPath = join(repo, '.scratch/s12b/node-profile-orchestration',
    version, inputPolicy, 'results.jsonl');
  if (!existsSync(savedPath)) throw new Error(`saved old S12b matrix missing: ${savedPath}`);
  const saved = readFileSync(savedPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(saved.slice(1).map(row => row.case), cases.map(item => item.name));
  const baseRoot = join(rawRoot, 'base');
  mkdirSync(baseRoot);
  writeFiles(baseRoot, baseFiles('node'));
  if (inputPolicy === OPAQUE_NPMRC_POLICY)
    writeFileSync(join(baseRoot, '.npmrc'), 'dummy fixture only; never read\n');
  const baseFilesList = allTests(baseRoot);
  const baselineOracle = fullOracle({ root: baseRoot, files: baseFilesList,
    out: join(rawRoot, 'bo'), nodePath, inputPolicy });
  assert.equal(outcome(baselineOracle.rows), 'pass');
  const baseline = verifiedCapture({ root: baseRoot, files: baseFilesList,
    out: join(rawRoot, 'bp'), nodePath, inputPolicy });
  assertSameRows(baseline.ordinaryFull.rows, baselineOracle.rows, 'baseline ordinary/profile');
  const input = await collect('node', baseRoot);
  assert.equal(verifyCollectorParity(input.tests, baseline.ordinaryFull.rows), null);
  assert.ok([version, `v${version}`].includes(input.runtime?.version));
  const { args: baselineArgs, bundle } = makeNodeProfileBundle({ baseRoot, input,
    sidecar: baseline.sidecar, nodePath, inputPolicy,
    baseCommit: `scratch-tree:${digest(safeFileInventory(baseRoot, { inputPolicy }))}` });
  save('baseline.json', { oracle: baselineOracle, capture: baseline, input, baselineArgs, bundle });
  const records = [];
  for (const [i, item] of cases.entries()) {
    const stem = String(i + 1).padStart(2, '0');
    const root = join(rawRoot, `h${stem}`);
    cpSync(baseRoot, root, { recursive: true });
    inject(root, 'node', item.name);
    const headFiles = allTests(root);
    const oracle = fullOracle({ root, files: headFiles, out: join(rawRoot, `o${stem}`),
      nodePath, inputPolicy });
    assert.equal(outcome(oracle.rows), item.oracle, `${item.name}: expected fault oracle`);
    let caseBundle = bundle;
    if (item.name === 'stale-baseline') caseBundle = { ...bundle,
      binding: { ...bundle.binding, tree: 'stale' } };
    if (item.name === 'corrupt-baseline') caseBundle = { ...bundle,
      core: { ...bundle.core, input: { ...bundle.core.input, tests: [] } } };
    const old = selectS12b({ ...baselineArgs, bundle: caseBundle, headRoot: root });
    const candidate = runSelectedHeadRequest({ bundle: caseBundle, baselineArgs,
      baseRoot, headRoot: root, fullFiles: baseFilesList, inputPolicy, nodePath,
      out: join(rawRoot, `c${stem}`),
      expectedProducerHash: EXPECTED_PRODUCER.producerHash });
    const expected = saved[i + 1];
    compareDecision(item.name, expected, old, candidate.decision);
    assert.equal(candidate.decision.kind, item.expect);
    assert.equal(outcome(oracle.rows), expected.oracle);
    let selected = null, proof = null;
    if (candidate.decision.kind === 'selected') {
      assert.equal(candidate.assessment?.kind, 'accepted',
        `${item.name}: S16 trace refused: ${candidate.assessment?.reason}`);
      const full = verifiedCapture({ root, files: headFiles,
        out: join(rawRoot, `f${stem}`), nodePath, inputPolicy });
      assertSameRows(full.ordinaryFull.rows, oracle.rows, `${item.name}: ordinary/profile full`);
      const oldCapture = selectedOld({ root, files: old.files,
        fullFiles: baseFilesList, out: join(rawRoot, `s${stem}`), bundle,
        baselineArgs, version, inputPolicy, nodePath });
      proof = compareSelected(item.name, oracle.rows, oldCapture.selectedHead.rows,
        candidate.capture?.selectedHead?.rows, candidate.decision.files);
      selected = outcome(candidate.capture.selectedHead.rows);
      assert.equal(selected, expected.selected);
      assert.equal(selected, item.oracle);
      assert.equal(candidate.capture.ordinaryFull, null, 'candidate hidden full');
      assert.equal(candidate.capture.constrainedFull.parity, null);
    } else {
      assert.equal(candidate.capture, null, `${item.name}: unexpected selected execution`);
      assert.equal(candidate.counters.selectedProcesses, 0);
      if (candidate.decision.kind === 'full') {
        assert.equal(item.name, 'config-input');
        assert.equal(candidate.assessment?.kind, 'not-run');
      } else assert.equal(candidate.assessment?.kind, 'refuse');
    }
    const record = { case: item.name, expectedOracle: item.oracle,
      oracle: outcome(oracle.rows), fullFiles: headFiles, fullRows: oracle.rows,
      expectedDecision: item.expect, oldDecision: old.kind,
      decision: candidate.decision.kind, oldReason: old.reason,
      candidateReason: candidate.decision.reason,
      selectedFiles: candidate.decision.files, selected, proof,
      strictSubset: candidate.decision.kind === 'selected' &&
        candidate.decision.files.length < headFiles.length,
      counters: candidate.counters, timings: candidate.timings };
    records.push(record);
    save(`case-${String(i + 1).padStart(2, '0')}-${item.name}.json`, record);
    process.stdout.write(`${version} ${inputPolicy} ${item.name}: ${record.decision}/${record.oracle}\n`);
  }
  const counts = summarize(records);
  const summary = { version: 's16-safety-matrix/1', runtime: version, inputPolicy,
    savedS12b: savedPath, rawRoot, ...counts, producerHash: EXPECTED_PRODUCER.producerHash };
  save('summary.json', summary);
  process.stdout.write(JSON.stringify(summary) + '\n');
}

try { await main(); }
catch (error) {
  save('failure.json', { message: error.message, stack: error.stack });
  throw error;
}
