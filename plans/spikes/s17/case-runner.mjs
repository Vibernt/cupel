// One whole mutation request, with source analysis, validity, fresh test runs and confirmation.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [modulePath, casePath] = process.argv.slice(2);
if (!modulePath || !casePath) throw new Error('usage: case-runner.mjs module-path case.json');
const { root, input, options } = JSON.parse(readFileSync(casePath, 'utf8'));
const { mutateNode, confirmSurvivors } = await import(pathToFileURL(modulePath));
global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const started = performance.now();
const metrics = {}, logs = [];
const mutation = await mutateNode({ root, input, ...options, metrics, jobs: 1, log: line => logs.push(line) });
const survivors = mutation.mutants.filter(m => m.status === 'survived').map(m => m.id);
const afterMutation = performance.now();
const confirmationMetrics = {};
const confirmed = await confirmSurvivors({ root, input, mutation, ids: survivors, jobs: 1,
  collectorKind: options.collectorKind, config: options.config, metrics: confirmationMetrics,
  log: line => logs.push(line) });
const wholeWallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
global.gc?.();
const memory = process.memoryUsage();
process.stdout.write(JSON.stringify({ mutation, confirmed, metrics, confirmationMetrics, logs,
  counts: { tests: input.tests.length, mutants: mutation.mutants.length, survivorRechecks: survivors.length },
  timing: { mutationMs: afterMutation - started, confirmationMs: wholeWallMs - (afterMutation - started), wholeWallMs },
  resources: { parentCpuUserMs: cpu.user / 1000, parentCpuSystemMs: cpu.system / 1000,
    heapBeforeGcBytes: heapBefore, retainedHeapDeltaBytes: memory.heapUsed - heapBefore,
    rssAfterBytes: memory.rss, parentMaxRssKiB: process.resourceUsage().maxRSS } }) + '\n');
