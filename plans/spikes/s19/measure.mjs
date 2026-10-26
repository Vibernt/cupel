import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { decision, median } from './analysis.mjs';
import { assertSource, PRODUCT_MUTATE_HASH } from './pin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const [runtimeManifestPath, caseManifestPath] = process.argv.slice(2).map(path => resolve(path ?? ''));
assert.ok(runtimeManifestPath.startsWith(join(repo, '.scratch/s19/runtime-')),
  'S19 runtime must be a new ignored pinned copy');
assert.ok(caseManifestPath.startsWith(join(repo, '.scratch/s17/approved9e-node')),
  'S19 cases must be accepted pinned S17 fixture inputs');
const runtime = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));
const cases = JSON.parse(readFileSync(caseManifestPath, 'utf8'));
assert.equal(runtime.version, 'cupel-s19-runtime/1');
assert.equal(cases.runtime, process.version);
assert.equal(runtime.productMutationSourceHash, PRODUCT_MUTATE_HASH);
const projectSource = join(repo, 'packages/cupel/src/mutate');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pins = Object.fromEntries(Object.entries(runtime.copies).map(([kind, copy]) =>
  [kind, copy.mutationSourceHash]));
function verify() {
  assertSource(projectSource, PRODUCT_MUTATE_HASH);
  assertSource(join(repo, 'packages/cupel/src'), runtime.productClosure.sourceHash);
  assertSource(join(repo, 'packages/cupel/schemas'), runtime.productClosure.schemaHash);
  assert.equal(sha(join(repo, 'packages/cupel/src/engine/lines.mjs')),
    runtime.productClosure.parserHash, 'product coverage parser changed');
  for (const [kind, copy] of Object.entries(runtime.copies)) {
    assertSource(join(copy.module, '..'), pins[kind]);
    const packageSrc = join(copy.module, '../..');
    assertSource(packageSrc, copy.sourceHash);
    assertSource(join(packageSrc, '../schemas'), copy.schemaHash);
    assert.equal(sha(join(packageSrc, 'engine/lines.mjs')), copy.parserHash,
      `${kind}: coverage parser changed`);
  }
  for (const [name, casePath] of Object.entries(cases.cases)) {
    const saved = JSON.parse(readFileSync(casePath, 'utf8'));
    for (const [path, expected] of Object.entries(cases.fingerprints[name]))
      assert.equal(sha(join(saved.root, path)), expected, `${name}: fixture changed`);
  }
}
verify();
function clockPairNs() {
  const samples = [];
  for (let rep = 0; rep < 5; rep++) {
    const start = performance.now();
    for (let i = 0; i < 50_000; i++) { const a = process.hrtime.bigint(); process.hrtime.bigint() - a; }
    samples.push((performance.now() - start) * 1e6 / 50_000);
  }
  return median(samples);
}
const clockCost = clockPairNs();
const out = mkdtempSync(join(repo, '.scratch/s19/profile-'));
const runner = join(repo, 'plans/spikes/s19/case-runner.mjs');
const outcomes = { version: 'cupel-s19-profile/1', runtime: process.version,
  node: process.execPath, copiedRuntime: runtimeManifestPath, caseManifest: caseManifestPath,
  mutationSourcePins: { product: PRODUCT_MUTATE_HASH, ...pins },
  productClosure: runtime.productClosure,
  copiedClosures: Object.fromEntries(Object.entries(runtime.copies).map(([name, copy]) =>
    [name, { sourceHash: copy.sourceHash, schemaHash: copy.schemaHash,
      parserHash: copy.parserHash }])), clockPairNs: clockCost,
  jobs: 'Cupel default; no jobs argument supplied', cases: {} };
function runCase(name, casePath, kind, label) {
  verify();
  const begun = performance.now();
  const child = spawnSync(process.execPath, ['--expose-gc', runner,
    runtime.copies[kind].module, casePath, kind], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const invocationWallMs = performance.now() - begun;
  writeFileSync(join(out, `${name}-${label}-${kind}.log.json`), JSON.stringify({
    status: child.status, signal: child.signal, error: child.error?.message ?? null,
    stdout: child.stdout, stderr: child.stderr, invocationWallMs }, null, 2) + '\n');
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${name}/${kind}: ${child.stderr}`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.mode, kind);
  assert.equal(result.metrics.run, result.counts.mutants);
  verify();
  return { ...result, invocationWallMs };
}
function parity(a, b, name) {
  for (const key of ['mutation', 'confirmed', 'counts', 'metrics', 'confirmationMetrics'])
    assert.deepEqual(a[key], b[key], `${name}: ${key} differs`);
}
const compact = value => ({ invocationWallMs: value.invocationWallMs,
  timing: value.timing, resources: value.resources, profiles: value.profiles,
  counts: value.counts, metrics: value.metrics,
  confirmationMetrics: value.confirmationMetrics });
try {
  for (const [name, casePath] of Object.entries(cases.cases)) {
    const warmed = {};
    for (const kind of ['control', 'instrumented'])
      warmed[kind] = runCase(name, casePath, kind, 'warm');
    parity(warmed.control, warmed.instrumented, `${name}/warm`);
    const pairs = [];
    for (let i = 0; i < 3; i++) {
      const pair = {};
      for (const kind of i % 2 ? ['instrumented', 'control'] : ['control', 'instrumented'])
        pair[kind] = runCase(name, casePath, kind, `pair${i + 1}`);
      parity(pair.control, pair.instrumented, `${name}/pair${i + 1}`);
      pairs.push(pair);
    }
    let measured = decision(pairs.map(pair => pair.control.timing.wholeWallMs),
      pairs.map(pair => pair.instrumented), clockCost);
    let outer = null;
    if (measured.outerTimerNeeded) {
      const controls = [], outerRuns = [];
      for (let i = 0; i < 3; i++) {
        const pair = {};
        for (const kind of i % 2 ? ['outer', 'control'] : ['control', 'outer'])
          pair[kind] = runCase(name, casePath, kind, `outer${i + 1}`);
        parity(pair.control, pair.outer, `${name}/outer${i + 1}`);
        controls.push(pair.control);
        outerRuns.push(pair.outer);
      }
      const outerSelectMs = median(outerRuns.map(value =>
        (value.profiles.mutation.selectNs + value.profiles.confirmation.selectNs) / 1e6));
      measured = decision(pairs.map(pair => pair.control.timing.wholeWallMs),
        pairs.map(pair => pair.instrumented), clockCost, outerSelectMs);
      outer = { reason: 'near or passing threshold; outer-only timer confirms selection share',
        controlWallsMs: controls.map(value => value.timing.wholeWallMs),
        runs: outerRuns.map(compact) };
    }
    outcomes.cases[name] = { label: name === 'source-heavy' ? 'synthetic executable whole request' :
      'existing runner fixture', warm: Object.fromEntries(Object.entries(warmed).map(([key, value]) =>
        [key, compact(value)])), pairs: pairs.map(pair => ({ control: compact(pair.control),
        instrumented: compact(pair.instrumented) })), outer, measured };
    process.stdout.write(`${name}: exact output/counters; select ${measured.selectMs.toFixed(3)} ms; ` +
      `repeated parse ${measured.repeatedParseMs.toFixed(3)} ms; control ${measured.denominatorMs.toFixed(3)} ms\n`);
    writeFileSync(join(out, 'results.partial.json'), JSON.stringify(outcomes, null, 2) + '\n');
  }
  verify();
  writeFileSync(join(out, 'results.json'), JSON.stringify(outcomes, null, 2) + '\n');
  process.stdout.write(`${join(out, 'results.json')}\n`);
} catch (error) {
  writeFileSync(join(out, 'failure.json'), JSON.stringify({ message: error.message,
    stack: error.stack, partial: outcomes }, null, 2) + '\n');
  throw error;
}
