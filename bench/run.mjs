#!/usr/bin/env node
// Benchmark orchestrator. It never runs candidate source on the host.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { dockerRun, cupelCommand, shellQuote } from './docker.mjs';
import { median, testCounts, peakKb, reportMetrics, guardMetrics, planMetrics } from './parse.mjs';
import { recentCommits, commitChangedLines, testFile } from './git.mjs';

const benchDir = import.meta.dirname;
const repos = JSON.parse(readFileSync(join(benchDir, 'repos.json'), 'utf8'));
const stages = ['install', 'baseline', 'report', 'guard-replay', 'plan-replay'];
const pendingRunners = new Set(['go', 'cargo', 'dotnet', 'minitest']);
const [name, requested] = process.argv.slice(2);
const repo = repos.find((item) => item.name === name);
if (!repo || ![...stages, 'all'].includes(requested)) {
  console.error(`usage: node bench/run.mjs <${repos.map((r) => r.name).join('|')}> <${[...stages, 'all'].join('|')}>`);
  process.exit(2);
}
if (repo.dir !== resolve('/Users/vid/cupel/.scratch/bench/repos', repo.name) || !existsSync(repo.dir)) {
  console.error(`repository path is missing or unexpected: ${repo.dir}`);
  process.exit(2);
}
const resultDir = join(benchDir, 'results', repo.name);
mkdirSync(resultDir, { recursive: true });

function save(stage, result) {
  const path = join(resultDir, `${stage}.json`);
  writeFileSync(path, JSON.stringify({ name, stage, runner: repo.runner, image: repo.image, ...result }, null, 2) + '\n');
  console.log(`${name} ${stage}: ${result.status}`);
  return result;
}
function load(stage) {
  const path = join(resultDir, `${stage}.json`);
  if (!existsSync(path)) throw new Error(`${stage} result is missing; run that stage first`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.status !== 'ok' && value.status !== 'pending: collector') throw new Error(`${stage} did not complete: ${value.reason ?? value.status}`);
  return value;
}
function tail(result) { return (result.stderr || result.stdout).trim().slice(-1200); }
function checked(result, label) {
  if (result.exitCode !== 0) throw new Error(`${label} exited ${result.exitCode}: ${tail(result)}`);
  return result;
}
function config() {
  const path = join(repo.dir, '.cupel-bench.json');
  writeFileSync(path, JSON.stringify(repo.cupelConfig, null, 2) + '\n');
  return path;
}
function parseJson(result, label) {
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${label} did not produce JSON (exit ${result.exitCode}): ${tail(result)}`); }
}
function inputAt(path = join(repo.dir, '.cupel', 'input.json')) {
  if (!existsSync(path)) throw new Error(`Cupel input is missing: ${path}`);
  const input = JSON.parse(readFileSync(path, 'utf8'));
  if (!input.tests?.length) throw new Error('Cupel collected zero tests; collector selection must be fixed');
  if (repo.runner === 'vitest' && !/vitest/i.test(input.runtime?.name ?? '')) throw new Error(`expected Vitest collector, got ${input.runtime?.name ?? 'unknown'}`);
  if (repo.runner === 'pytest' && !/pytest/i.test(input.runtime?.name ?? '')) throw new Error(`expected pytest collector, got ${input.runtime?.name ?? 'unknown'}`);
  return input;
}
const reportOptions = (out = '/work/.cupel/input.json', mutation = true) =>
  `--config /work/.cupel-bench.json --json --runs 2 ${mutation ? '' : '--no-mutation '}--out ${out}`;

async function install() {
  const hydrate = "git -c safe.directory=/work -C /work fetch --refetch --no-filter origin HEAD && GIT_NO_LAZY_FETCH=1 git -c safe.directory=/work -C /work rev-list --objects --missing=print HEAD > /tmp/cupel-objects && if grep -q '^?' /tmp/cupel-objects; then echo 'missing Git objects after hydration' >&2; exit 1; fi";
  const command = `set -eu; apt-get update && apt-get install -y --no-install-recommends git; ${repo.install}; ${hydrate}`;
  const result = await dockerRun(repo, 'bridge', command);
  return save('install', { status: result.exitCode === 0 ? 'ok' : 'failed', wallMs: result.wallMs, exitCode: result.exitCode,
    reason: result.exitCode ? tail(result) : null });
}
async function baseline() {
  load('install');
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const result = await dockerRun(repo, 'none', repo.test);
    runs.push({ wallMs: result.wallMs, exitCode: result.exitCode, counts: testCounts(repo.runner, result.stdout + '\n' + result.stderr),
      reason: result.exitCode ? tail(result) : null });
  }
  return save('baseline', { status: runs.length === 3 && runs.every((r) => r.exitCode === 0) ? 'ok' : 'failed', runs,
    medianMs: median(runs.map((r) => r.wallMs)), reason: runs.find((r) => r.exitCode !== 0)?.reason ?? null });
}
async function report() {
  load('baseline');
  if (pendingRunners.has(repo.runner)) return save('report', { status: 'pending: collector', reason: `${repo.runner} collector is not available` });
  config();
  const collectionCommand = cupelCommand(repo, 'report', reportOptions('/work/.cupel/collection-input.json', false));
  const collection = checked(await dockerRun(repo, 'none', collectionCommand), 'collection-only report');
  parseJson(collection, 'collection-only report');
  const collectionInput = inputAt(join(repo.dir, '.cupel', 'collection-input.json'));
  const collectionRunDurationSumsMs = [0, 1].map((index) => collectionInput.tests.reduce((total, test) => total + (test.durationsMs?.[index] ?? 0), 0));
  const full = checked(await dockerRun(repo, 'none', cupelCommand(repo, 'report', reportOptions(), true)), 'Cupel report');
  const parsed = parseJson(full, 'Cupel report');
  const input = inputAt();
  const metrics = reportMetrics(parsed, input);
  return save('report', { status: 'ok', collectionMs: collection.wallMs, collectionRunDurationSumsMs, wallMs: full.wallMs, peakKb: peakKb(full.stderr),
    overheadRatio: load('baseline').medianMs ? collection.wallMs / load('baseline').medianMs : null,
    collectedTests: input.tests.length, inputRuntime: input.runtime, pending: parsed.suite.criticalMutation == null ? ['mutation'] : [], ...metrics });
}

async function archivedInstall(commit, side, target) {
  const tree = `/work/${target}`;
  const ref = side === 'base' ? `${commit}^` : commit;
  const bootstrapGit = 'apt-get update && apt-get install -y --no-install-recommends git && ';
  const command = `set -eu; ${bootstrapGit}mkdir -p ${shellQuote(tree)}; GIT_NO_LAZY_FETCH=1 git -c safe.directory=/work -C /work archive --format=tar --output=/tmp/cupel-archive.tar ${shellQuote(ref)}; tar -xf /tmp/cupel-archive.tar -C ${shellQuote(tree)}; git init -q ${shellQuote(tree)}; cp /work/.cupel-bench.json ${shellQuote(tree)}/.cupel-bench.json; cd ${shellQuote(tree)}; ${repo.install}`;
  return checked(await dockerRun(repo, 'bridge', command), `archive/install ${commit} ${side}`);
}
async function archivedReport(target) {
  const tree = `/work/${target}`;
  const result = checked(await dockerRun(repo, 'none', cupelCommand(repo, 'report', `--config ${tree}/.cupel-bench.json --json --runs 2 --out ${tree}/.cupel/input.json`), tree), `replay collection ${target}`);
  parseJson(result, `replay collection ${target}`);
  const input = inputAt(join(repo.dir, target, '.cupel', 'input.json'));
  return { wallMs: result.wallMs, tests: input.tests.length };
}
async function guardReplay() {
  load('report');
  if (pendingRunners.has(repo.runner)) return save('guard-replay', { status: 'pending: collector', reason: `${repo.runner} collector is not available` });
  const commits = await recentCommits(repo, 'test', 5);
  if (commits.length < 5) throw new Error(`only ${commits.length} test-changing non-merge commits found; need 5`);
  config();
  const outcomes = [];
  for (const { commit, changedPaths } of commits) {
    const parent = mkdtempSync(join(repo.dir, '.cupel-bench-replay-'));
    const relative = basename(parent);
    try {
      const base = `${relative}/base`; const head = `${relative}/head`;
      const baseInstall = await archivedInstall(commit, 'base', base);
      const baseCollect = await archivedReport(base);
      const headInstall = await archivedInstall(commit, 'head', head);
      const headCollect = await archivedReport(head);
      const command = cupelCommand(repo, 'guard', `--config /work/.cupel-bench.json --base-input /work/${base}/.cupel/input.json --head-input /work/${head}/.cupel/input.json --json`);
      const result = await dockerRun(repo, 'none', command);
      if (![0, 1].includes(result.exitCode)) throw new Error(`guard exited ${result.exitCode}: ${tail(result)}`);
      const metrics = guardMetrics(parseJson(result, 'guard'));
      outcomes.push({ commit, changedTests: changedPaths.filter(testFile), baseInstallMs: baseInstall.wallMs, headInstallMs: headInstall.wallMs,
        baseCollect, headCollect, exitCode: result.exitCode, ...metrics });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }
  if (repo.runner === 'pytest') checked(await dockerRun(repo, 'bridge', repo.install), 'restore root Python environment after replay');
  return save('guard-replay', { status: 'ok', outcomes });
}
async function planReplay() {
  load('report');
  if (pendingRunners.has(repo.runner)) return save('plan-replay', { status: 'pending: collector', reason: `${repo.runner} collector is not available` });
  const input = inputAt();
  const commits = await recentCommits(repo, 'source', 10);
  if (commits.length < 10) throw new Error(`only ${commits.length} source-changing non-merge commits found; need 10`);
  const outcomes = [];
  for (const { commit, changedPaths } of commits) {
    const changed = await commitChangedLines(repo, commit);
    const path = join(repo.dir, '.cupel-bench-changed-lines.json');
    try {
      writeFileSync(path, JSON.stringify(changed) + '\n');
      const result = checked(await dockerRun(repo, 'none', cupelCommand(repo, 'plan', '--config /work/.cupel-bench.json --input /work/.cupel/input.json --changed-lines /work/.cupel-bench-changed-lines.json --json')), `plan ${commit}`);
      outcomes.push({ commit, touchedTests: changedPaths.filter(testFile), changedSourceFiles: Object.keys(changed), ...planMetrics(parseJson(result, 'plan'), input, changedPaths.filter(testFile)) });
    } finally { rmSync(path, { force: true }); }
  }
  return save('plan-replay', { status: 'ok', outcomes });
}

const handlers = { install, baseline, report, 'guard-replay': guardReplay, 'plan-replay': planReplay };
let failed = false;
let failure = null;
for (const stage of requested === 'all' ? stages : [requested]) {
  try {
    const value = await handlers[stage]();
    if (value.status === 'failed') { failed = true; failure = { stage, reason: value.reason }; break; }
  } catch (error) {
    save(stage, { status: 'failed', reason: error.message });
    failed = true;
    failure = { stage, reason: error.message };
    break;
  }
}
if (requested === 'all') save('all', { status: failed ? 'failed' : 'ok', reason: failure ? `stopped at ${failure.stage}: ${failure.reason}` : null });
if (failed) process.exitCode = 1;
