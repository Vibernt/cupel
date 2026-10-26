import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync,
  symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseFiles, writeFiles } from '../s12/fixtures.mjs';
import { digest } from '../s12b/evidence.mjs';
import { safeFileInventory } from '../s12b/evidence-base.mjs';
import { captureNodeProfile } from '../s12b/node-profile/launch.mjs';
import { testRuntimes } from '../s12b/node-profile/test-runtimes.mjs';
import { rawHash } from './artifact.mjs';
import { prepareSealedBaseline } from './baseline.mjs';
import { sealedProducerProof } from './producer.mjs';
import { runSealedSelectedHead } from './request.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(repo, '.scratch/s18/tests');
mkdirSync(scratch, { recursive: true });
const unique = prefix => mkdtempSync(join(scratch, prefix));
const baseCommit = 's18-controlled-test-base';

function fixture(nodePath, version, inputPolicy = 'strict-v1', withDependency = false) {
  const baseRoot = unique('base-');
  writeFiles(baseRoot, baseFiles('node'));
  if (withDependency) {
    writeFiles(baseRoot, {
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 's18-fixture', version: '1.0.0' },
        'node_modules/dep': { version: '1.0.0' },
      } }),
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', version: '1.0.0',
        main: 'index.js' }),
      'node_modules/dep/index.js': 'module.exports = { value: 1 };\n',
    });
    const critical = join(baseRoot, 'tests/critical.test.mjs');
    writeFileSync(critical, `${readFileSync(critical, 'utf8')}\nimport dep from 'dep';\n` +
      "test('locked dependency', () => assert.equal(dep.value, 1));\n");
  }
  if (inputPolicy !== 'strict-v1')
    writeFileSync(join(baseRoot, '.npmrc'), 'opaque controlled fixture marker\n');
  const fullFiles = Object.keys(baseFiles('node')).filter(path => path.startsWith('tests/')).sort();
  const captured = captureNodeProfile({ root: baseRoot, files: fullFiles,
    out: unique('collector-'), nodePath, inputPolicy });
  assert.equal(captured.constrainedFull.parity, true);
  const inventory = safeFileInventory(baseRoot, { inputPolicy });
  const input = { spec: 'cupel-spec/1', kind: 'input',
    runtime: { name: 'node', version },
    sources: Object.fromEntries(Object.entries(inventory)
      .filter(([path]) => path.startsWith('src/'))
      .map(([path, hash]) => [path, { coverable: '1', hash: `sha256:${hash}` }])),
    tests: captured.ordinaryFull.rows.map((row, i) => ({
      id: `${row.file}::${row.id}::${i}`, file: row.file,
      name: row.id.slice(0, -2), status: row.status,
      tags: row.file === 'tests/critical.test.mjs' ? ['critical'] : [],
    })), coverage: { granularity: 'test', byTest: {}, byFile: {}, setup: {} } };
  const headRoot = unique('head-');
  cpSync(baseRoot, headRoot, { recursive: true });
  const expectedProducerHash = sealedProducerProof().producerHash;
  const prepared = prepareSealedBaseline({ baseRoot, baseCommit, input, fullFiles,
    inputPolicy, nodePath, out: unique('prepare-'), expectedProducerHash });
  const options = { artifactPath: prepared.artifactPath,
    expectedArtifactHash: prepared.artifactHash, expectedBaseCommit: baseCommit,
    expectedProducerHash, headRoot, nodePath, inputPolicy, out: unique('selected-') };
  return { options, prepared, baseRoot, headRoot, fullFiles };
}

function rewriteArtifact(options, edit) {
  const artifact = JSON.parse(readFileSync(options.artifactPath, 'utf8'));
  edit(artifact);
  const path = join(unique('tampered-'), 'sealed-baseline.json');
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  writeFileSync(path, bytes);
  return { ...options, artifactPath: path, expectedArtifactHash: rawHash(bytes) };
}

function mutateOnSignal(nodePath, signal, target, contents) {
  const script = `const fs=require('node:fs');let n=0;
    const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){
      fs.writeFileSync(process.argv[2],${JSON.stringify(contents)});
      clearInterval(timer);process.exit(0);
    }else if(++n>300){clearInterval(timer);process.exit(2)}},10);`;
  return spawn(nodePath, ['-e', script, signal, target], { stdio: 'ignore' });
}

for (const [version, nodePath] of testRuntimes) test(`S18 sealed selected actual runtime ${version}`, () => {
  const { options, prepared, baseRoot, headRoot } = fixture(nodePath, version);
  assert.ok(prepared.baselineTests > 0);
  assert.equal(readFileSync(prepared.artifactPath, 'utf8').includes(baseRoot), false);
  renameSync(baseRoot, `${baseRoot}-unavailable`);
  const source = join(headRoot, 'src/core.mjs');
  const old = readFileSync(source, 'utf8');
  const fixedTime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(source, fixedTime, fixedTime);
  const stat = statSync(source);
  writeFileSync(source, old.replace('n + 1', 'n + 2'));
  utimesSync(source, stat.atime, stat.mtime);
  assert.equal(statSync(source).size, stat.size);
  assert.equal(statSync(source).mtimeMs, stat.mtimeMs);
  const changed = runSealedSelectedHead(options);
  assert.equal(changed.decision.kind, 'selected', changed.decision.reason);
  assert.equal(changed.assessment.kind, 'accepted', changed.assessment.reason);
  assert.ok(changed.capture.selectedHead.rows.some(row => row.status === 'failed'));
  assert.equal(changed.counters.baselineRootReads, 0);
  assert.equal(changed.counters.artifactReads, 1);
  assert.equal(changed.counters.headTestUniverseWalks, 1);
  assert.equal(changed.counters.headInputSnapshots, 2);
  assert.equal(changed.counters.selectedProcesses, changed.decision.files.length);
  assert.ok(changed.decision.changed.includes('src/core.mjs'));
  assert.equal(changed.capture.sidecar.execution.producer.version,
    'cupel-s18-sealed-producer/1');
  writeFileSync(source, old);

  const missingPin = runSealedSelectedHead({ ...options, expectedArtifactHash: undefined });
  assert.equal(missingPin.assessment.kind, 'refuse');
  assert.equal(missingPin.counters.artifactReads, 0);
  const wrongPin = runSealedSelectedHead({ ...options,
    expectedArtifactHash: `sha256:${'0'.repeat(64)}` });
  assert.match(wrongPin.assessment.reason, /raw SHA-256 differs/);
  const wrongProducer = runSealedSelectedHead({ ...options,
    expectedProducerHash: `sha256:${'0'.repeat(64)}` });
  assert.match(wrongProducer.assessment.reason, /producer source differs/);
  for (const key of ['baseRoot', 'bundle', 'snapshot', 'validated', 'fullFiles']) {
    const injected = runSealedSelectedHead({ ...options, [key]: {} });
    assert.match(injected.assessment.reason, /caller-supplied context/);
    assert.equal(injected.counters.artifactReads, 0);
  }
  const wrongCommit = runSealedSelectedHead({ ...options, expectedBaseCommit: 'wrong' });
  assert.match(wrongCommit.assessment.reason, /base commit differs/);
  assert.equal(wrongCommit.counters.selectedProcesses, 0);
  const wrongPolicy = runSealedSelectedHead({ ...options,
    inputPolicy: 'express-root-npmrc-opaque-v1' });
  assert.match(wrongPolicy.assessment.reason, /input policy differs/);
  assert.equal(wrongPolicy.counters.selectedProcesses, 0);
  const otherNode = testRuntimes.find(([v]) => v !== version)[1];
  const wrongRuntime = runSealedSelectedHead({ ...options, nodePath: otherNode });
  assert.match(wrongRuntime.assessment.reason, /runtime invalid/);
  assert.equal(wrongRuntime.counters.selectedProcesses, 0);
  const truncatedPath = join(unique('truncated-'), 'sealed-baseline.json');
  writeFileSync(truncatedPath, readFileSync(options.artifactPath).subarray(0, 200));
  const truncated = runSealedSelectedHead({ ...options, artifactPath: truncatedPath });
  assert.match(truncated.assessment.reason, /raw SHA-256 differs/);
  const malformedPath = join(unique('malformed-'), 'sealed-baseline.json');
  const malformedBytes = Buffer.from('{');
  writeFileSync(malformedPath, malformedBytes);
  const malformed = runSealedSelectedHead({ ...options,
    artifactPath: malformedPath, expectedArtifactHash: rawHash(malformedBytes) });
  assert.match(malformed.assessment.reason, /artifact JSON malformed/);
  const missing = runSealedSelectedHead({ ...options,
    artifactPath: join(unique('missing-'), 'sealed-baseline.json') });
  assert.match(missing.assessment.reason, /ENOENT/);

  const missingSourceHash = rewriteArtifact(options, artifact => {
    delete artifact.baseline.bundle.core.input.sources['src/core.mjs'].hash;
  });
  assert.match(runSealedSelectedHead(missingSourceHash).assessment.reason,
    /canonical input source hashes/);
  const badCritical = rewriteArtifact(options, artifact => {
    artifact.baseline.bundle.core.criticalFiles = [];
  });
  assert.match(runSealedSelectedHead(badCritical).assessment.reason,
    /critical labels|baseline core/);
  const noProof = rewriteArtifact(options, artifact => {
    artifact.baseline.bundle.sidecar.files['tests/critical.test.mjs'].capabilities = [];
  });
  assert.match(runSealedSelectedHead(noProof).assessment.reason,
    /baseline sidecar binding|capability/);
  for (const label of ['tests/critical.test.mjs', 'global'])
    for (const badCapability of [null, '', 7]) {
      const rebound = rewriteArtifact(options, artifact => {
        const { bundle } = artifact.baseline;
        const channels = label === 'global' ? bundle.sidecar.global : bundle.sidecar.files[label];
        channels.capabilities.push(badCapability);
        bundle.binding.sidecar = digest(bundle.sidecar);
      });
      const invalidCapability = runSealedSelectedHead(rebound);
      assert.equal(invalidCapability.assessment.kind, 'refuse');
      assert.match(invalidCapability.assessment.reason,
        /capability\/unsupported evidence invalid/);
      assert.equal(invalidCapability.counters.selectedProcesses, 0);
    }
  const alteredProducer = rewriteArtifact(options, artifact => {
    artifact.producer.version = 'wrong';
  });
  assert.match(runSealedSelectedHead(alteredProducer).assessment.reason,
    /preparation producer differs/);
});

test('S18 includes new HEAD test and routes non-code changes to full without fallback', () => {
  const [version, nodePath] = testRuntimes.at(-1);
  const { options, headRoot } = fixture(nodePath, version);
  writeFileSync(join(headRoot, 'tests/new.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('new fails', () => assert.equal(1, 2));\n");
  const added = runSealedSelectedHead(options);
  assert.equal(added.decision.kind, 'selected', added.decision.reason);
  assert.ok(added.decision.files.includes('tests/new.test.mjs'));
  assert.equal(added.assessment.kind, 'accepted', added.assessment.reason);
  assert.ok(added.capture.selectedHead.rows.some(row => row.file === 'tests/new.test.mjs' &&
    row.status === 'failed'));
  writeFileSync(join(headRoot, 'config.json'), '{"enabled":false}\n');
  const full = runSealedSelectedHead(options);
  assert.equal(full.decision.kind, 'full', full.decision.reason);
  assert.equal(full.capture, null);
  assert.equal(full.assessment.kind, 'not-run');
  assert.equal(full.counters.selectedProcesses, 0);
  symlinkSync(join(headRoot, 'tests/core.test.mjs'),
    join(headRoot, 'tests/alias.test.mjs'));
  const linked = runSealedSelectedHead(options);
  assert.equal(linked.assessment.kind, 'refuse');
  assert.match(linked.assessment.reason, /test-universe symlink refused/);
  assert.equal(linked.counters.selectedProcesses, 0);
});

test('S18 saved dependency bytes and opaque descriptor remain bounded', () => {
  const [version, nodePath] = testRuntimes.at(-1);
  const { options, headRoot } = fixture(nodePath, version,
    'express-root-npmrc-opaque-v1', true);
  assert.equal(readFileSync(options.artifactPath, 'utf8')
    .includes('opaque controlled fixture marker'), false);
  writeFileSync(join(headRoot, '.npmrc'), 'different opaque fixture marker\n');
  const accepted = runSealedSelectedHead(options);
  assert.equal(accepted.assessment.kind, 'accepted', accepted.assessment.reason);
  assert.equal(accepted.capture.sidecar.denials.length, 0);
  const dependency = join(headRoot, 'node_modules/dep/index.js');
  writeFileSync(dependency, 'module.exports = { value: 2 };\n');
  const changed = runSealedSelectedHead(options);
  assert.equal(changed.assessment.kind, 'refuse');
  assert.match(changed.assessment.reason, /baseline dependency bytes changed/);
  assert.equal(changed.counters.selectedProcesses, 0);
  const missingDependencyProof = rewriteArtifact(options, artifact => {
    artifact.baseline.bundle.sidecar.dependencies.files = {};
  });
  const invalid = runSealedSelectedHead(missingDependencyProof);
  assert.equal(invalid.assessment.kind, 'refuse');
  assert.match(invalid.assessment.reason, /observed evidence differs|sidecar binding/);
});

for (const [version, nodePath] of testRuntimes) test(`S18 fresh postflight rejects in-run source change ${version}`, () => {
  const { options, headRoot } = fixture(nodePath, version);
  const core = join(headRoot, 'tests/core.test.mjs');
  writeFileSync(core, `${readFileSync(core, 'utf8')}\nimport { writeFileSync } from 'node:fs';\n` +
    "test('post snapshot handshake', () => { writeFileSync(process.env.TMPDIR + '/signal', 'go');" +
    ' Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); });\n');
  const source = join(headRoot, 'src/core.mjs');
  const signal = join(options.out, 'tests_core.test.mjs', 'signal');
  const updater = mutateOnSignal(nodePath, signal, source,
    `// S18 in-run mutation\n${readFileSync(source, 'utf8')}`);
  const result = runSealedSelectedHead(options);
  assert.equal(result.decision.kind, 'selected', result.decision.reason);
  assert.equal(result.assessment.kind, 'refuse');
  assert.match(result.assessment.reason, /changed-input-inventory/);
  assert.equal(result.counters.headInputSnapshots, 2);
  assert.equal(result.counters.selectedProcesses, result.decision.files.length);
  assert.match(readFileSync(source, 'utf8'), /S18 in-run mutation/);
  updater.unref();
});
