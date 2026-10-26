// One complete default-jobs mutation and survivor-confirmation request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { newProfile, profileData } from './instrument.mjs';

const [modulePath, casePath, mode] = process.argv.slice(2);
assert.ok(modulePath && casePath && ['control', 'instrumented', 'outer'].includes(mode),
  'usage: case-runner.mjs <module> <case.json> control|instrumented|outer');
const { root, input, options } = JSON.parse(readFileSync(casePath, 'utf8'));
assert.equal(Object.hasOwn(options, 'jobs'), false, 'S19 must use default jobs');
globalThis.__CUPEL_S19_PROFILE = newProfile();
const { mutateNode, confirmSurvivors } = await import(pathToFileURL(modulePath));
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const started = performance.now();
const metrics = {}, confirmationMetrics = {};
const mutation = await mutateNode({ root, input, ...options, metrics });
const afterMutation = performance.now();
const mutationProfile = profileData(globalThis.__CUPEL_S19_PROFILE);
globalThis.__CUPEL_S19_PROFILE = newProfile();
const survivors = mutation.mutants.filter(row => row.status === 'survived').map(row => row.id);
const confirmed = await confirmSurvivors({ root, input, mutation, ids: survivors,
  collectorKind: options.collectorKind, config: options.config,
  metrics: confirmationMetrics });
const confirmationProfile = profileData(globalThis.__CUPEL_S19_PROFILE);
const wholeWallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
global.gc?.();
const memory = process.memoryUsage();
process.stdout.write(`${JSON.stringify({ mode, mutation, confirmed, metrics,
  confirmationMetrics, profiles: { mutation: mutationProfile, confirmation: confirmationProfile },
  counts: { tests: input.tests.length, mutants: mutation.mutants.length,
    survivorRechecks: survivors.length },
  timing: { mutationMs: afterMutation - started,
    confirmationMs: wholeWallMs - (afterMutation - started), wholeWallMs },
  resources: { parentCpuUserMs: cpu.user / 1000, parentCpuSystemMs: cpu.system / 1000,
    heapBeforeGcBytes: heapBefore, retainedHeapDeltaBytes: memory.heapUsed - heapBefore,
    rssAfterBytes: memory.rss, parentMaxRssKiB: process.resourceUsage().maxRSS } })}\n`);
