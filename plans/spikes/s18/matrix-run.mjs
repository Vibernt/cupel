#!/usr/bin/env node
// Four-mode correctness oracle. This harness is excluded from the S18 producer.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { baseFiles, cases, inject, writeFiles } from '../s12/fixtures.mjs';
import { normalizeInputPolicy, OPAQUE_NPMRC_POLICY,
  safeFileInventory } from '../s12b/evidence-base.mjs';
import { collect } from '../s12b/run-execute.mjs';
import { digest, verifyCollectorParity } from '../s12b/evidence.mjs';
import { nodeVersion } from '../s12b/evidence-node-context.mjs';
import { selectS12b } from '../s12b/selection.mjs';
import { EXPECTED_PRODUCER, currentProducerProof } from '../s16/frozen-producer.mjs';
import { fullOracle, selectedOld } from '../s16/matrix-capture.mjs';
import { compareDecision, compareSelected, outcome, summarize } from '../s16/matrix-support.mjs';
import { assertSameRows } from '../s16/oracle.mjs';
import { rawHash } from './artifact.mjs';
import { prepareSealedBaseline } from './baseline.mjs';
import { sealedProducerProof } from './producer.mjs';
import { runSealedSelectedHead } from './request.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const allowedRawParent = join(repo, '.scratch/s18/oracle');
const EXPECTED_S18_PRODUCER =
  'sha256:797e69818bf163cc661fd659ae633cb82549660d200a0fff9a4e8f0f865ecdfe';
const [nodePathArg, policyArg, rawArg] = process.argv.slice(2);
if (!nodePathArg || !policyArg || !rawArg)
  throw new Error('usage: node matrix-run.mjs /absolute/node strict-v1|express-root-npmrc-opaque-v1 /absolute/.scratch/s18/oracle/unique-run');
const nodePath = resolve(nodePathArg);
const inputPolicy = normalizeInputPolicy(policyArg);
const version = nodeVersion(nodePath);
if (realpathSync(process.execPath) !== realpathSync(nodePath) ||
  process.versions.node !== version)
  throw new Error('S18 matrix orchestration must run with the selected exact Node binary');
const rawRoot = resolve(rawArg);
if (dirname(rawRoot) !== allowedRawParent || existsSync(rawRoot))
  throw new Error('S18 matrix raw directory must be a new direct oracle child');
if (Buffer.byteLength(basename(rawRoot)) > 12)
  throw new Error('S18 matrix raw name exceeds 12 bytes; keep profile TMPDIR short');
mkdirSync(rawRoot, { recursive: true });
const save = (name, value) => writeFileSync(join(rawRoot, name),
  `${JSON.stringify(value, null, 2)}\n`);
const allTests = root => Object.keys(safeFileInventory(root, { inputPolicy }))
  .filter(path => /^tests\/.+\.test\.[cm]?js$/.test(path)).sort();

function alteredArtifact(prepared, stem, change) {
  const artifact = JSON.parse(readFileSync(prepared.artifactPath, 'utf8'));
  change(artifact);
  const dir = join(rawRoot, `bad${stem}`);
  mkdirSync(dir);
  const artifactPath = join(dir, 'sealed-baseline.json');
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  writeFileSync(artifactPath, bytes);
  return { artifactPath, expectedArtifactHash: rawHash(bytes) };
}

async function main() {
  assert.deepEqual(currentProducerProof(), EXPECTED_PRODUCER,
    'S16 frozen producer changed');
  assert.equal(sealedProducerProof().producerHash, EXPECTED_S18_PRODUCER,
    'S18 frozen producer changed');
  const savedPath = join(repo, '.scratch/s12b/node-profile-orchestration',
    version, inputPolicy, 'results.jsonl');
  if (!existsSync(savedPath)) throw new Error(`saved S12b matrix missing: ${savedPath}`);
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
  const input = await collect('node', baseRoot);
  assert.equal(verifyCollectorParity(input.tests, baselineOracle.rows), null);
  assert.ok([version, `v${version}`].includes(input.runtime?.version));
  const baseCommit = `scratch-tree:${digest(safeFileInventory(baseRoot, { inputPolicy }))}`;
  const prepared = prepareSealedBaseline({ baseRoot, baseCommit, input,
    fullFiles: baseFilesList, inputPolicy, nodePath, out: join(rawRoot, 'p'),
    expectedProducerHash: EXPECTED_S18_PRODUCER });
  const artifact = JSON.parse(readFileSync(prepared.artifactPath, 'utf8'));
  assertSameRows(artifact.baseline.rows.ordinary, baselineOracle.rows,
    'S18 sealed baseline ordinary/full oracle');
  const bundle = artifact.baseline.bundle;
  const baselineArgs = { ...artifact.args, baseRoot };
  save('baseline-summary.json', { baseCommit, fullFiles: baseFilesList,
    tests: baselineOracle.rows.length, prepared, sourceHashCount: Object.keys(input.sources).length,
    opaqueDescriptor: bundle.binding.opaqueRootNpmrc });

  // Establish every original decision and fresh full oracle while the trusted
  // fixture exists. Consume begins only after its original path is removed.
  const casesBeforeConsume = [];
  for (const [i, item] of cases.entries()) {
    const stem = String(i + 1).padStart(2, '0');
    const root = join(rawRoot, `h${stem}`);
    cpSync(baseRoot, root, { recursive: true });
    inject(root, 'node', item.name);
    const headFiles = allTests(root);
    const oracle = fullOracle({ root, files: headFiles,
      out: join(rawRoot, `o${stem}`), nodePath, inputPolicy });
    assert.equal(outcome(oracle.rows), item.oracle, `${item.name}: full oracle differs`);
    let caseBundle = bundle;
    if (item.name === 'stale-baseline') caseBundle = { ...bundle,
      binding: { ...bundle.binding, tree: 'stale' } };
    if (item.name === 'corrupt-baseline') caseBundle = { ...bundle,
      core: { ...bundle.core, input: { ...bundle.core.input, tests: [] } } };
    const old = selectS12b({ ...baselineArgs, bundle: caseBundle, headRoot: root });
    const oldCapture = old.kind === 'selected' ? selectedOld({ root,
      files: old.files, fullFiles: baseFilesList, out: join(rawRoot, `s${stem}`),
      bundle, baselineArgs, version, inputPolicy, nodePath }) : null;
    casesBeforeConsume.push({ stem, item, root, headFiles, oracle, old, oldCapture });
    process.stdout.write(`${version} ${inputPolicy} ${item.name}: oracle/old ready\n`);
  }
  rmSync(baseRoot, { recursive: true });
  assert.equal(existsSync(baseRoot), false, 'baseline path must be unavailable before consume');

  const records = [];
  for (const [i, savedCase] of casesBeforeConsume.entries()) {
    const { stem, item, root, headFiles, oracle, old, oldCapture } = savedCase;
    let artifactPath = prepared.artifactPath;
    let expectedArtifactHash = prepared.artifactHash;
    if (item.name === 'stale-baseline') ({ artifactPath, expectedArtifactHash } =
      alteredArtifact(prepared, stem, value => { value.baseline.bundle.binding.tree = 'stale'; }));
    if (item.name === 'corrupt-baseline') ({ artifactPath, expectedArtifactHash } =
      alteredArtifact(prepared, stem, value => { value.baseline.bundle.core.input.tests = []; }));
    const candidate = runSealedSelectedHead({ artifactPath, expectedArtifactHash,
      expectedBaseCommit: baseCommit, expectedProducerHash: EXPECTED_S18_PRODUCER,
      headRoot: root, nodePath, inputPolicy, out: join(rawRoot, `c${stem}`) });
    const expected = saved[i + 1];
    compareDecision(item.name, expected, old, candidate.decision);
    assert.equal(candidate.decision.kind, item.expect);
    assert.equal(candidate.counters.baselineRootReads, 0);
    assert.equal(candidate.counters.artifactReads, 1);
    assert.equal(existsSync(baseRoot), false, 'consume recreated/read baseline path');
    let selected = null, proof = null;
    if (candidate.decision.kind === 'selected') {
      assert.equal(candidate.assessment?.kind, 'accepted',
        `${item.name}: S18 trace refused: ${candidate.assessment?.reason}`);
      proof = compareSelected(item.name, oracle.rows,
        oldCapture.selectedHead.rows, candidate.capture?.selectedHead?.rows,
        candidate.decision.files);
      selected = outcome(candidate.capture.selectedHead.rows);
      assert.equal(selected, expected.selected);
      assert.equal(selected, item.oracle);
      assert.equal(candidate.capture.ordinaryFull, null, 'candidate hidden full');
      assert.equal(candidate.capture.constrainedFull.parity, null);
      assert.equal(candidate.counters.headInputSnapshots, 2);
      assert.equal(candidate.counters.selectedProcesses, candidate.decision.files.length);
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
      baselineUnavailableAtConsume: true,
      counters: candidate.counters, timings: candidate.timings };
    records.push(record);
    save(`case-${stem}-${item.name}.json`, record);
    process.stdout.write(`${version} ${inputPolicy} ${item.name}: ${record.decision}/${record.oracle}\n`);
  }
  const counts = summarize(records);
  const summary = { version: 's18-sealed-safety-matrix/1', runtime: version,
    inputPolicy, savedS12b: savedPath, rawRoot,
    baselineUnavailableForAllConsume: records.every(row => row.baselineUnavailableAtConsume),
    baselineRootReads: records.reduce((n, row) => n + row.counters.baselineRootReads, 0),
    ...counts, producerHash: EXPECTED_S18_PRODUCER,
    artifactHash: prepared.artifactHash };
  save('summary.json', summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

try { await main(); }
catch (error) {
  save('failure.json', { message: error.message, stack: error.stack });
  throw error;
}
