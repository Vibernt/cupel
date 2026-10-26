import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baseFiles, writeFiles } from '../s12/fixtures.mjs';
import { safeFileInventory } from '../s12b/evidence-base.mjs';
import { captureNodeProfile } from '../s12b/node-profile/launch.mjs';
import { FROZEN_PROFILE_RUNTIME_HASH, makeNodeProfileBundle,
  nodeProfilePolicy } from '../s12b/evidence-node-context.mjs';
import { selectS12b } from '../s12b/selection.mjs';
import { testRuntimes } from '../s12b/node-profile/test-runtimes.mjs';
import { producerProof } from './producer.mjs';
import { runSelectedHeadRequest } from './request.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(repo, '.scratch/s16/request-tests');
mkdirSync(scratch, { recursive: true });
const unique = prefix => mkdtempSync(join(scratch, prefix));

function mutateOnSignal(nodePath, signal, target, contents) {
  const script = `const fs=require('node:fs');let n=0;
    const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){
      fs.writeFileSync(process.argv[2],${JSON.stringify(contents)});
      clearInterval(timer);process.exit(0);
    }else if(++n>300){clearInterval(timer);process.exit(2)}},10);`;
  return spawn(nodePath, ['-e', script, signal, target], { stdio: 'ignore' });
}

function addHandshakeTest(headRoot) {
  const core = join(headRoot, 'tests/core.test.mjs');
  writeFileSync(core, `${readFileSync(core, 'utf8')}\nimport { writeFileSync } from 'node:fs';\n` +
    "test('post snapshot handshake', () => { writeFileSync(process.env.TMPDIR + '/signal', 'go');" +
    ' Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); });\n');
}

function setup(nodePath, version, inputPolicy = 'strict-v1', withDependency = false) {
  const baseRoot = unique('base-');
  writeFiles(baseRoot, baseFiles('node'));
  if (withDependency) {
    writeFiles(baseRoot, {
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 's16-fixture', version: '1.0.0' },
        'node_modules/dep': { version: '1.0.0' },
      } }),
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0',
        main: 'index.js' }),
      'node_modules/dep/index.js': 'module.exports = { value: 1 };\n',
    });
    const critical = join(baseRoot, 'tests/critical.test.mjs');
    writeFileSync(critical, `${readFileSync(critical, 'utf8')}\nimport dep from 'dep';\n` +
      "test('critical dependency package', () => assert.equal(dep.value, 1));\n");
  }
  if (inputPolicy !== 'strict-v1') writeFileSync(join(baseRoot, '.npmrc'),
    'opaque fixture marker with no credential\n');
  const fullFiles = Object.keys(baseFiles('node')).filter(path =>
    path.startsWith('tests/')).sort();
  const baseline = captureNodeProfile({ root: baseRoot, files: fullFiles,
    out: unique('baseline-out-'), nodePath, inputPolicy });
  assert.equal(baseline.constrainedFull.parity, true);
  const inventory = safeFileInventory(baseRoot, { inputPolicy });
  const tests = baseline.ordinaryFull.rows.map((row, i) => ({
    id: `${row.file}::${row.id}::${i}`, file: row.file,
    name: row.id.slice(0, -2), status: row.status,
    tags: row.file === 'tests/critical.test.mjs' ? ['critical'] : [],
  }));
  const input = { spec: 'cupel-spec/1', kind: 'input',
    runtime: { name: 'node', version },
    sources: Object.fromEntries(Object.entries(inventory)
      .filter(([path]) => path.startsWith('src/'))
      .map(([path, hash]) => [path, { coverable: '1', hash: `sha256:${hash}` }])),
    tests, coverage: { granularity: 'test', byTest: {}, byFile: {}, setup: {} } };
  const { args: baselineArgs, bundle } = makeNodeProfileBundle({ baseRoot,
    input, sidecar: baseline.sidecar, nodePath, baseCommit: 's16-test-base', inputPolicy });
  const headRoot = unique('head-');
  cpSync(baseRoot, headRoot, { recursive: true });
  const options = { bundle, baselineArgs, baseRoot, headRoot, fullFiles,
    inputPolicy, nodePath, out: unique('selected-out-'),
    expectedProducerHash: producerProof(FROZEN_PROFILE_RUNTIME_HASH).producerHash };
  return { options, baseline };
}

for (const [version, nodePath] of testRuntimes) test(`S16 verified request ${version}`, () => {
  const { options } = setup(nodePath, version);
  const source = join(options.headRoot, 'src/core.mjs');
  writeFileSync(source, readFileSync(source, 'utf8').replace('n + 1', 'n + 2'));
  const old = selectS12b({ bundle: options.bundle, headRoot: options.headRoot,
    ...options.baselineArgs });
  const result = runSelectedHeadRequest(options);
  assert.deepEqual(result.decision, old);
  assert.equal(result.assessment.kind, 'accepted', result.assessment.reason);
  const oldPolicy = nodeProfilePolicy({ root: options.headRoot, files: options.fullFiles,
    version, inputPolicy: options.inputPolicy });
  const oldCapture = captureNodeProfile({ mode: 'selected-head', root: options.headRoot,
    files: old.files, fullFiles: options.fullFiles, out: unique('old-selected-out-'),
    nodePath, inputPolicy: options.inputPolicy,
    binding: { baselineConfigHash: options.bundle.sidecar.execution.configHash,
      baselineParity: true, headConfigHash: oldPolicy.identity.configHash,
      environmentPolicyHash: oldPolicy.identity.environmentPolicyHash,
      dependencyLockHash: oldPolicy.identity.dependencyLockHash,
      profileRuntimeHash: oldPolicy.identity.profileRuntimeHash,
      dependencyEvidence: options.bundle.sidecar.dependencies.files } });
  assert.deepEqual(result.capture.selectedHead.rows, oldCapture.selectedHead.rows);
  assert.equal(result.capture.ordinaryFull, null);
  assert.equal(result.capture.constrainedFull.parity, null);
  assert.deepEqual(result.counters, { baselineInputSnapshots: 1,
    headInputSnapshots: 2, selectedProcesses: old.files.length });
  assert.ok(result.capture.selectedHead.rows.some(row => row.status === 'failed'));
  assert.equal(result.capture.sidecar.execution.producer.version, 'cupel-s16-producer/1');
  assert.notEqual(result.capture.sidecar.execution.profileRuntimeHash,
    options.bundle.sidecar.execution.profileRuntimeHash);
  assert.equal(result.capture.sidecar.denials.length, 0);
  assert.deepEqual(result.capture.sidecar.global.unsupported, []);
  const spoofed = runSelectedHeadRequest({ ...options, snapshot: { files: {} } });
  assert.equal(spoofed.decision.kind, 'refuse');
  assert.match(spoofed.decision.reason, /caller-supplied context/);
  assert.equal(spoofed.counters.headInputSnapshots, 0);
  const wrongPin = runSelectedHeadRequest({ ...options,
    expectedProducerHash: `sha256:${'0'.repeat(64)}` });
  assert.equal(wrongPin.decision.kind, 'refuse');
  assert.match(wrongPin.decision.reason, /frozen acceptance pin/);
  assert.equal(wrongPin.counters.selectedProcesses, 0);
  const missingPin = runSelectedHeadRequest({ ...options, expectedProducerHash: undefined });
  assert.equal(missingPin.decision.kind, 'refuse');
  assert.equal(missingPin.counters.headInputSnapshots, 0);
  writeFileSync(join(options.baseRoot, 'config.json'), '{"enabled":false}\n');
  const stale = runSelectedHeadRequest(options);
  assert.equal(stale.decision.kind, 'refuse');
  assert.match(stale.decision.reason, /baseline/);
  assert.equal(stale.counters.headInputSnapshots, 0);
});

for (const [version, nodePath] of testRuntimes) test(`S16 opaque root proof ${version}`, () => {
  const { options } = setup(nodePath, version, 'express-root-npmrc-opaque-v1');
  writeFileSync(join(options.headRoot, '.npmrc'), 'different opaque fixture marker\n');
  const result = runSelectedHeadRequest(options);
  assert.equal(result.assessment.kind, 'accepted', result.assessment.reason);
  assert.deepEqual(result.counters, { baselineInputSnapshots: 1,
    headInputSnapshots: 2, selectedProcesses: result.decision.files.length });
  assert.ok(result.capture.sidecar.files[result.decision.files[0]].capabilities
    .includes('baseline-privacy-bound'));
});

for (const [version, nodePath] of testRuntimes) test(`S16 lock, symlink and spoof refusals ${version}`, () => {
  const { options } = setup(nodePath, version);
  const lock = join(options.headRoot, 'package-lock.json');
  writeFileSync(lock, '{"lockfileVersion":3,"packages":{}}\n');
  const changedLock = runSelectedHeadRequest(options);
  assert.equal(changedLock.decision.kind, 'refuse');
  assert.match(changedLock.decision.reason, /dependency lock identity differs/);
  assert.equal(changedLock.counters.selectedProcesses, 0);
  const original = join(options.headRoot, 'tests/core.test.mjs');
  symlinkSync(original, join(options.headRoot, 'tests/alias.test.mjs'));
  const linked = runSelectedHeadRequest(options);
  assert.equal(linked.decision.kind, 'refuse');
  assert.match(linked.decision.reason, /symlink/);
  assert.equal(linked.counters.selectedProcesses, 0);
  const spoofed = structuredClone(options.bundle);
  spoofed.sidecar.files[options.fullFiles[0]].capabilities.pop();
  const invalid = runSelectedHeadRequest({ ...options, bundle: spoofed });
  assert.equal(invalid.decision.kind, 'refuse');
  assert.match(invalid.decision.reason, /baseline sidecar identity differs/);
  const smaller = runSelectedHeadRequest({ ...options,
    fullFiles: options.fullFiles.slice(1) });
  assert.equal(smaller.decision.kind, 'refuse');
  assert.match(smaller.decision.reason, /full file universe differs/);
});

for (const [version, nodePath] of testRuntimes) test(`S16 installed package bytes ${version}`, () => {
  const { options } = setup(nodePath, version, 'strict-v1', true);
  const dependency = 'node_modules/dep/index.js';
  assert.ok(options.bundle.sidecar.dependencies.files[dependency]);
  const accepted = runSelectedHeadRequest(options);
  assert.equal(accepted.assessment.kind, 'accepted', accepted.assessment.reason);
  assert.equal(accepted.capture.sidecar.dependencies.files[dependency],
    options.bundle.sidecar.dependencies.files[dependency]);
  writeFileSync(join(options.headRoot, dependency), 'module.exports = { value: 2 };\n');
  const stale = runSelectedHeadRequest(options);
  assert.equal(stale.decision.kind, 'refuse');
  assert.match(stale.decision.reason, /baseline dependency bytes changed before/);
  assert.equal(stale.counters.selectedProcesses, 0);
});

for (const [version, nodePath] of testRuntimes) test(`S16 post mutation refusal ${version}`, () => {
  const { options } = setup(nodePath, version);
  addHandshakeTest(options.headRoot);
  const source = join(options.headRoot, 'src/core.mjs');
  const original = readFileSync(source, 'utf8');
  const signal = join(options.out, 'tests_core.test.mjs', 'signal');
  const updater = mutateOnSignal(nodePath, signal, source,
    `// S16 in-run mutation\n${original}`);
  const result = runSelectedHeadRequest(options);
  assert.equal(result.decision.kind, 'selected');
  assert.equal(result.assessment.kind, 'refuse');
  assert.match(result.assessment.reason, /changed-input-inventory/);
  assert.equal(result.counters.headInputSnapshots, 2);
  assert.equal(result.counters.selectedProcesses, result.decision.files.length);
  assert.match(readFileSync(source, 'utf8'), /S16 in-run mutation/);
  updater.unref();
});

for (const [version, nodePath] of testRuntimes) test(`S16 in-run dependency refusal ${version}`, () => {
  const { options } = setup(nodePath, version, 'strict-v1', true);
  addHandshakeTest(options.headRoot);
  const dependency = join(options.headRoot, 'node_modules/dep/index.js');
  const signal = join(options.out, 'tests_core.test.mjs', 'signal');
  const updater = mutateOnSignal(nodePath, signal, dependency,
    'module.exports = { value: 2 };\n');
  const result = runSelectedHeadRequest(options);
  assert.equal(result.decision.kind, 'selected');
  assert.equal(result.assessment.kind, 'refuse');
  assert.match(result.assessment.reason, /baseline-dependency-bytes-changed-during-run|dependency differs/);
  assert.equal(result.counters.headInputSnapshots, 2);
  assert.match(readFileSync(dependency, 'utf8'), /value: 2/);
  updater.unref();
});

for (const [version, nodePath] of testRuntimes) test(`S16 caught denial remains refusal ${version}`, () => {
  const { options } = setup(nodePath, version);
  const core = join(options.headRoot, 'tests/core.test.mjs');
  writeFileSync(core, `${readFileSync(core, 'utf8')}\nimport { readFileSync } from 'node:fs';\n` +
    "test('caught denied read', () => { try { readFileSync('/tmp/s16-outside'); } catch {} });\n");
  const result = runSelectedHeadRequest(options);
  assert.equal(result.decision.kind, 'selected');
  assert.equal(result.assessment.kind, 'refuse');
  assert.match(result.assessment.reason, /persistent denials/);
  assert.ok(result.capture.sidecar.denials.length);
});

test('S16 preserves D16 full route without running a hidden fallback', () => {
  const [version, nodePath] = testRuntimes.at(-1);
  const { options } = setup(nodePath, version);
  writeFileSync(join(options.headRoot, 'config.json'), '{"enabled":false}\n');
  const old = selectS12b({ bundle: options.bundle, headRoot: options.headRoot,
    ...options.baselineArgs });
  const result = runSelectedHeadRequest(options);
  assert.deepEqual(result.decision, old);
  assert.equal(result.decision.kind, 'full');
  assert.equal(result.capture, null);
  assert.equal(result.assessment.kind, 'not-run');
  assert.deepEqual(result.counters, { baselineInputSnapshots: 1,
    headInputSnapshots: 1, selectedProcesses: 0 });
});

test('S16 detects producer source changed during execution in isolated code copy', async () => {
  const [version, nodePath] = testRuntimes.at(-1);
  const { options } = setup(nodePath, version);
  const isolated = unique('code-copy-');
  for (const dir of ['plans/spikes/s16', 'plans/spikes/s12b',
    'packages/cupel/src/engine', 'packages/cupel/src/analysis', 'spec/schemas']) {
    mkdirSync(dirname(join(isolated, dir)), { recursive: true });
    cpSync(join(repo, dir), join(isolated, dir), { recursive: true });
  }
  const isolatedProducer = await import(pathToFileURL(join(isolated,
    'plans/spikes/s16/producer.mjs')).href);
  const isolatedRequest = await import(pathToFileURL(join(isolated,
    'plans/spikes/s16/request.mjs')).href);
  options.expectedProducerHash = isolatedProducer
    .producerProof(FROZEN_PROFILE_RUNTIME_HASH).producerHash;
  addHandshakeTest(options.headRoot);
  const target = join(isolated, 'plans/spikes/s16/producer.mjs');
  const signal = join(options.out, 'tests_core.test.mjs', 'signal');
  const updater = mutateOnSignal(nodePath, signal, target,
    `${readFileSync(target, 'utf8')}\n// changed during selected execution\n`);
  const result = isolatedRequest.runSelectedHeadRequest(options);
  assert.equal(result.decision.kind, 'selected');
  assert.equal(result.assessment.kind, 'refuse');
  assert.match(result.assessment.reason, /producer source changed during/);
  assert.equal(result.counters.selectedProcesses, result.decision.files.length);
  updater.unref();
});
