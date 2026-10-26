import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedPin, assertFrozenSource } from './source-pin.mjs';
import { assertConfirmationMetrics, assertSourceMetrics } from './metrics.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const dir = resolve(process.argv[2] ?? '');
if (!dir.startsWith(join(repo, '.scratch/s17/'))) throw new Error('diagnostic output must be under .scratch/s17');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json')));
assert.equal(manifest.runtime, process.version);
const modulePaths = {
  old: join(repo, '.scratch/s17/old-runtime/packages/cupel/src/mutate/index.mjs'),
  guards: join(repo, '.scratch/s17/guards-only-runtime/packages/cupel/src/mutate/index.mjs'),
  current: join(repo, 'packages/cupel/src/mutate/index.mjs'),
};
const expectedDigest = approvedPin(JSON.parse(readFileSync(join(repo, 'plans/spikes/s17/frozen-source.json'))));
const guardsDigest = approvedPin(JSON.parse(readFileSync(join(repo, 'plans/spikes/s17/frozen-guards.json'))));
assertFrozenSource(join(repo, 'packages/cupel/src/mutate'), expectedDigest);
assertFrozenSource(join(modulePaths.guards, '..'), guardsDigest);
const result = { runtime: process.version, note: 'diagnostic-only preload; excluded from warm timing', cases: {} };
for (const [name, casePath] of Object.entries(manifest.cases)) {
  const calls = {};
  const { root } = JSON.parse(readFileSync(casePath));
  for (const [method, modulePath] of Object.entries(modulePaths)) {
    const countPath = join(dir, `${name}-${method}-spawn-counts.json`);
    const child = spawnSync(process.execPath, ['--expose-gc', '--require',
      join(repo, 'plans/spikes/s17/diagnostic-spawns.cjs'),
      join(repo, 'plans/spikes/s17/case-runner.mjs'), modulePath, casePath], {
      cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CUPEL_S17_SPAWN_COUNTS: countPath,
        CUPEL_S17_PROJECT_ROOT: root, NO_COLOR: '1' },
    });
    if (child.error || child.status !== 0) throw new Error(`${name}/${method}: ${child.error?.message ?? child.stderr}`);
    const run = JSON.parse(child.stdout);
    const spawns = JSON.parse(readFileSync(countPath));
    if (name === 'jest-existing') assert.ok(spawns.jest > 0, 'Jest execution was missing');
    else assert.ok(spawns.test > 0, 'node:test execution was missing');
    calls[method] = { spawns, metrics: run.metrics, confirmationMetrics: run.confirmationMetrics,
      counts: run.counts, mutation: run.mutation, confirmed: run.confirmed, timing: run.timing,
      resources: run.resources };
  }
  for (const method of ['guards', 'current']) {
    assert.deepEqual(calls.old.mutation, calls[method].mutation, `${name}/${method}: diagnostic mutation mismatch`);
    assert.deepEqual(calls.old.confirmed, calls[method].confirmed, `${name}/${method}: diagnostic confirmation mismatch`);
    assertSourceMetrics(calls[method].metrics);
    assertConfirmationMetrics(calls[method].confirmationMetrics, calls[method].counts.survivorRechecks);
    assert.equal(calls.old.spawns.test, calls[method].spawns.test,
      `${name}/${method}: fresh node:test launch count mismatch`);
    assert.equal(calls.old.spawns.jest, calls[method].spawns.jest,
      `${name}/${method}: fresh Jest launch count mismatch`);
  }
  result.cases[name] = calls;
  process.stdout.write(`${name}: three-way fresh runner counts match\n`);
}
assertFrozenSource(join(repo, 'packages/cupel/src/mutate'), expectedDigest);
assertFrozenSource(join(modulePaths.guards, '..'), guardsDigest);
writeFileSync(join(dir, 'diagnostic.json'), JSON.stringify(result, null, 2) + '\n');
