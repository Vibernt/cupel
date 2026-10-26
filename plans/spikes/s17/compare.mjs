// Differential correctness and five alternating whole-mutation measurements.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { assertMutationParity, median } from './parity.mjs';
import { approvedPin, assertFrozenSource, sourceHashes } from './source-pin.mjs';
import { assertConfirmationMetrics, assertSourceMetrics } from './metrics.mjs';
import { threeWayOrder } from './schedule.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const [mode, rawDir] = process.argv.slice(2);
const dir = resolve(rawDir ?? '');
if (!['check', 'timing'].includes(mode) || !dir.startsWith(join(repo, '.scratch/s17/')))
  throw new Error('usage: compare.mjs check|timing .scratch/s17/<prepared-dir>');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json')));
assert.equal(manifest.runtime, process.version);
const pre = JSON.parse(readFileSync(join(repo, `.scratch/s17/baseline-node${process.versions.node.split('.')[0]}/baseline.json`)));
const old = join(repo, '.scratch/s17/old-runtime/packages/cupel/src/mutate/index.mjs');
const guards = join(repo, '.scratch/s17/guards-only-runtime/packages/cupel/src/mutate/index.mjs');
const current = join(repo, 'packages/cupel/src/mutate/index.mjs');
const modules = { old, guards, current };
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const expectedDigest = approvedPin(JSON.parse(readFileSync(join(repo, 'plans/spikes/s17/frozen-source.json'))));
const guardsDigest = approvedPin(JSON.parse(readFileSync(join(repo, 'plans/spikes/s17/frozen-guards.json'))));
for (const [path, expected] of Object.entries(pre.sourceHashes))
  assert.equal(sha(join(repo, '.scratch/s17/old-runtime/', path)), expected, `old source changed: ${path}`);
const sources = { old: sourceHashes(join(old, '..')),
  guards: assertFrozenSource(join(guards, '..'), guardsDigest),
  current: assertFrozenSource(join(current, '..'), expectedDigest) };
assert.deepEqual(Object.keys(sources.old).sort(), Object.keys(pre.sourceHashes)
  .map(path => path.slice('packages/cupel/src/mutate/'.length)).sort(), 'old source file set changed');
function verifyFixtures() {
  for (const [name, casePath] of Object.entries(manifest.cases)) {
    const { root } = JSON.parse(readFileSync(casePath));
    for (const [file, expected] of Object.entries(manifest.fingerprints[name]))
      assert.equal(sha(join(root, file)), expected, `${name}: fixture changed: ${file}`);
  }
}
verifyFixtures();
const driver = join(repo, 'plans/spikes/s17/case-runner.mjs');
function run(which, casePath) {
  const modulePath = modules[which];
  if (!modulePath) throw new Error(`unknown mutation method: ${which}`);
  const start = performance.now();
  const child = spawnSync(process.execPath, ['--expose-gc', driver, modulePath, casePath], {
    cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const invocationWallMs = performance.now() - start;
  if (child.error || child.status !== 0) throw new Error(`${which} ${casePath}: ${child.error?.message ?? `exit ${child.status}: ${child.stderr}`}`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.metrics.run, result.mutation.mutants.length);
  assert.equal(result.counts.mutants, result.mutation.mutants.length);
  return { ...result, invocationWallMs };
}
const result = { mode, runtime: process.version, platform: process.platform, arch: process.arch,
  frozenSourceDigest: expectedDigest, frozenGuardsDigest: guardsDigest, sourceHashes: sources, cases: {} };
for (const [name, casePath] of Object.entries(manifest.cases)) {
  const first = run('old', casePath);
  const guarded = run('guards', casePath);
  const second = run('current', casePath);
  assertSourceMetrics(guarded.metrics);
  assertConfirmationMetrics(guarded.confirmationMetrics, guarded.counts.survivorRechecks);
  assertSourceMetrics(second.metrics);
  assertConfirmationMetrics(second.confirmationMetrics, second.counts.survivorRechecks);
  assertMutationParity(first, guarded, `${name} guards`);
  assertMutationParity(first, second, name);
  const saved = pre.cases[name === 'node-existing' ? 'node-synthetic' : name];
  if (saved) {
    assert.deepEqual(first.mutation, saved.mutation, `${name}: pre-edit baseline mutation drift`);
    assert.deepEqual(first.confirmed, saved.confirmed, `${name}: pre-edit baseline confirmation drift`);
    assert.deepEqual(Object.fromEntries(Object.keys(saved.metrics).map(key => [key, first.metrics[key]])),
      saved.metrics, `${name}: pre-edit baseline metrics drift`);
  }
  const pairs = [];
  if (mode === 'timing') {
    // Every method has already warmed once. Reversed triplets alternate both pairwise orders.
    for (let i = 0; i < 5; i++) {
      const pair = {};
      for (const which of threeWayOrder(i)) pair[which] = run(which, casePath);
      assertSourceMetrics(pair.guards.metrics);
      assertConfirmationMetrics(pair.guards.confirmationMetrics, pair.guards.counts.survivorRechecks);
      assertSourceMetrics(pair.current.metrics);
      assertConfirmationMetrics(pair.current.confirmationMetrics, pair.current.counts.survivorRechecks);
      assertMutationParity(pair.old, pair.guards, `${name} guards pair ${i + 1}`);
      assertMutationParity(pair.old, pair.current, `${name} pair ${i + 1}`);
      pairs.push(pair);
    }
  }
  const compact = call => ({ invocationWallMs: call.invocationWallMs, ...call.timing, ...call.resources });
  result.cases[name] = { counts: first.counts, oldMetrics: first.metrics,
    guardsMetrics: guarded.metrics, currentMetrics: second.metrics,
    oldConfirmationMetrics: first.confirmationMetrics, guardsConfirmationMetrics: guarded.confirmationMetrics,
    currentConfirmationMetrics: second.confirmationMetrics,
    first: { old: compact(first), guards: compact(guarded), current: compact(second) },
    pairs: pairs.map(pair => Object.fromEntries(Object.entries(pair).map(([key, value]) => [key, compact(value)]))),
    medians: pairs.length ? Object.fromEntries(['invocationWallMs', 'wholeWallMs',
      'parentCpuUserMs', 'parentCpuSystemMs', 'retainedHeapDeltaBytes', 'rssAfterBytes', 'parentMaxRssKiB'].map(key =>
        [key, Object.fromEntries(['old', 'guards', 'current'].map(which =>
          [which, median(pairs.map(p => p[which][key] ?? p[which].timing?.[key] ?? p[which].resources?.[key]))]))])) : null };
  process.stdout.write(`${name}: exact output and counts; ${pairs.length} pairs\n`);
}
assert.deepEqual(sourceHashes(join(old, '..')), sources.old, 'old source changed during measurement');
assertFrozenSource(join(guards, '..'), guardsDigest);
assertFrozenSource(join(current, '..'), expectedDigest);
verifyFixtures();
writeFileSync(join(dir, `${mode}.json`), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(`${join(dir, `${mode}.json`)}\n`);
