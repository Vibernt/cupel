// Capture exact pre-change mutation outputs. Run from the repository root on each Node runtime.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { makeProject } from '../../../packages/cupel/test/mutate-helpers.mjs';
import { mutateNode, confirmSurvivors } from '../../../packages/cupel/src/mutate/index.mjs';
import { collectJest } from '../../../packages/cupel/src/collect/jest/index.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(process.argv[2] ?? '');
if (!out.startsWith(join(repo, '.scratch/s17/'))) throw new Error('output must be under .scratch/s17');
mkdirSync(out, { recursive: false });
const source = join(repo, 'packages/cupel/src/mutate');
cpSync(source, join(out, 'mutate-source'), { recursive: true });
const hashes = {};
function hashFiles(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) hashFiles(path);
    else hashes[relative(repo, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
hashFiles(source);
const record = { runtime: process.version, sourceHashes: hashes, cases: {} };
async function measure(name, root, input, options) {
  const metrics = {}, logs = [];
  const start = performance.now();
  const mutation = await mutateNode({ root, input, metrics, jobs: 1, log: line => logs.push(line), ...options });
  const mutateWallMs = performance.now() - start;
  const survivors = mutation.mutants.filter(m => m.status === 'survived').map(m => m.id);
  const confirmStart = performance.now();
  const confirmed = await confirmSurvivors({ root, input, mutation, ids: survivors, jobs: 1,
    collectorKind: options.collectorKind, config: options.config, log: line => logs.push(line) });
  record.cases[name] = { input, options: { scope: options.scope, config: options.config,
    collectorKind: options.collectorKind }, mutation, confirmed, metrics, logs,
  mutateWallMs, confirmWallMs: performance.now() - confirmStart,
  counts: { tests: input.tests.length, mutants: mutation.mutants.length, survivors: survivors.length,
    status: Object.fromEntries([...new Set(mutation.mutants.map(m => m.status))].map(status =>
      [status, mutation.mutants.filter(m => m.status === status).length])) } };
}
const project = makeProject();
try {
  await measure('node-synthetic', project.root, project.input, {
    scope: { changed: { 'src/calc.mjs': '2-3' } },
    config: { mutation: { maxMutants: 6, maxSeconds: 60, seed: 17 } },
  });
} finally { project.cleanup(); }
const jestRoot = join(repo, 'spec/conformance/adapters/jest');
const jestInput = await collectJest({ root: jestRoot, runs: 2, recheck: [] });
await measure('jest-existing', jestRoot, jestInput, {
  scope: { targeted: ['tests/typed.test.ts::transformed source map'] },
  config: { mutation: { maxMutants: 2, maxSeconds: 60, seed: 17 } }, collectorKind: 'jest',
});
writeFileSync(join(out, 'baseline.json'), JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify({ runtime: record.runtime, hashes: Object.keys(hashes).length,
  cases: Object.fromEntries(Object.entries(record.cases).map(([k, v]) => [k, { counts: v.counts, metrics: v.metrics,
    mutateWallMs: v.mutateWallMs, confirmWallMs: v.confirmWallMs }])) }) + '\n');
