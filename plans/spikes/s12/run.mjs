#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { collectNode } from '../../../packages/cupel/src/collect/node/index.mjs';
import { collectVitest } from '../../../packages/cupel/src/collect/vitest/index.mjs';
import { collectJest } from '../../../packages/cupel/src/collect/jest/index.mjs';
import { linkVitestModules } from '../../../packages/cupel/test/vitest-modules.mjs';
import { baseFiles, cases, inject, writeFiles } from './fixtures.mjs';
import { makeEvidence, select } from './selection.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const scratch = join(repo, '.scratch/s12');
const vitestModules = '/Users/vid/codecrystal/hub-ts/node_modules';
const jestModules = join(repo, '.scratch/jest-runtime/node_modules');
const python = join(repo, '.scratch/package-tools/runtime/bin/python');
const pySrc = join(repo, 'packages/cupel-py/src');
const requested = process.argv.slice(2);
const runners = requested.length ? requested : ['node', 'vitest', 'jest', 'pytest'];

function execute(runner, root, files = []) {
  const started = performance.now();
  let command; let args; let env = { ...process.env, CI: '1', NO_COLOR: '1', PYTHONNOUSERSITE: '1' };
  if (runner === 'node') { command = process.execPath; args = ['--test', '--test-reporter=tap', ...(files.length ? files : readdirSync(join(root, 'tests')).filter((file) => file.endsWith('.test.mjs')).map((file) => `tests/${file}`))]; }
  else if (runner === 'vitest') { command = process.execPath; args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files]; }
  else if (runner === 'jest') { command = process.execPath; args = [join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--no-cache', ...files]; }
  else if (runner === 'pytest') { command = python; args = ['-m', 'pytest', '-q', ...files]; env.PYTHONPATH = [join(root, 'src'), root, env.PYTHONPATH].filter(Boolean).join(':'); }
  else throw new Error(`unsupported runner ${runner}`);
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const failed = runner === 'node' ? Number([...output.matchAll(/^# fail (\d+)/gm)].at(-1)?.[1] ?? NaN) :
    runner === 'vitest' ? Number([...output.matchAll(/Tests\s+.*?(\d+) failed/g)].at(-1)?.[1] ?? [...output.matchAll(/Test Files\s+.*?(\d+) failed/g)].at(-1)?.[1] ?? (result.status === 0 ? 0 : NaN)) :
      runner === 'jest' ? Number([...output.matchAll(/Tests:\s+.*?(\d+) failed/g)].at(-1)?.[1] ?? [...output.matchAll(/Test Suites:\s+.*?(\d+) failed/g)].at(-1)?.[1] ?? (result.status === 0 ? 0 : NaN)) :
      Number([...output.matchAll(/(\d+) failed/g)].at(-1)?.[1] ?? [...output.matchAll(/(\d+) errors?/g)].at(-1)?.[1] ?? (result.status === 0 ? 0 : NaN));
  const outcome = result.error || !Number.isFinite(failed) ? 'error' : failed > 0 ? 'fail' : result.status === 0 ? 'pass' : 'error';
  return { outcome, failed: Number.isFinite(failed) ? failed : null, exitCode: result.status, wallMs: Math.round(performance.now() - started),
    error: result.error?.message ?? (outcome === 'error' ? output.slice(-1200) : null), output };
}

function availability(runner) {
  if (runner === 'node') return { runtime: `node ${process.version}`, config: { runner, command: process.execPath } };
  if (runner === 'vitest') {
    const path = join(vitestModules, 'vitest/package.json');
    if (!existsSync(path)) throw new Error(`Vitest runtime missing: ${path}`);
    const version = JSON.parse(readFileSync(path, 'utf8')).version;
    return { runtime: `vitest ${version}; node ${process.version}`, config: { runner, command: join(vitestModules, 'vitest/vitest.mjs') } };
  }
  if (runner === 'jest') {
    const path = join(jestModules, 'jest/package.json');
    if (!existsSync(path)) throw new Error(`Jest runtime missing: ${path}`);
    const version = JSON.parse(readFileSync(path, 'utf8')).version;
    return { runtime: `jest ${version}; node ${process.version}`, config: { runner, command: join(jestModules, 'jest/bin/jest.js') } };
  }
  if (runner === 'pytest') {
    const probe = spawnSync(python, ['-m', 'pytest', '--version'], { env: { ...process.env, PYTHONNOUSERSITE: '1' }, encoding: 'utf8' });
    if (probe.status !== 0) throw new Error(`pytest runtime unavailable: ${probe.stderr || probe.stdout}`);
    return { runtime: `${python}; ${probe.stdout.trim()}`, config: { runner, command: python } };
  }
  throw new Error(`unsupported runner ${runner}`);
}

async function collect(runner, root) {
  if (runner === 'node') return collectNode({ root, runs: 1 });
  if (runner === 'vitest') return collectVitest({ root, runs: 1 });
  if (runner === 'jest') return collectJest({ root, config: { runners: { jest: {} } }, runs: 1, recheck: [], log: () => {} });
  const out = join(root, '.scratch/input.json');
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const result = spawnSync(python, ['-m', 'vibernt_cupel', 'collect', '--root', root, '--runs', '1', '--out', out],
    { cwd: root, env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONPATH: [join(root, 'src'), pySrc, root].join(':') }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 });
  if (result.status !== 0 || !existsSync(out)) throw new Error(`pytest collection failed: ${result.stderr || result.stdout || result.error?.message}`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

async function runRunner(runner, records) {
  const { runtime, config } = availability(runner);
  const logs = join(scratch, runner);
  mkdirSync(logs, { recursive: true });
  const base = mkdtempSync(join(scratch, `${runner}-base-`));
  writeFiles(base, baseFiles(runner));
  if (runner === 'vitest') linkVitestModules(base, vitestModules);
  if (runner === 'jest') symlinkSync(jestModules, join(base, 'node_modules'), 'dir');
  const setupStarted = performance.now();
  const baseline = execute(runner, base);
  writeFileSync(join(logs, 'baseline-full.log'), baseline.output);
  if (baseline.outcome !== 'pass') throw new Error(`${runner} baseline full run ${baseline.outcome}: ${baseline.error ?? baseline.output.slice(-1200)}`);
  const input = await collect(runner, base);
  const evidence = makeEvidence({ baseRoot: base, input, runner, runtime, config });
  writeFileSync(join(logs, 'baseline-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  const setupMs = Math.round(performance.now() - setupStarted);
  records.push({ runner, phase: 'baseline', runtime, setupMs, tests: input.tests.length, files: [...new Set(input.tests.map((test) => test.file))].length,
    coverageGranularity: input.coverage.granularity, baselineWallMs: baseline.wallMs, identity: evidence.identity });
  for (const fault of cases) {
    const head = mkdtempSync(join(scratch, `${runner}-${fault.name}-`));
    cpSync(base, head, { recursive: true, filter: (path) => !relative(base, path).split('/').some((part) => ['node_modules', '.scratch', '__pycache__', '.pytest_cache'].includes(part)) });
    if (runner === 'vitest') linkVitestModules(head, vitestModules);
    if (runner === 'jest') symlinkSync(jestModules, join(head, 'node_modules'), 'dir');
    inject(head, runner, fault.name);
    const oracle = execute(runner, head);
    writeFileSync(join(logs, `${fault.name}-full.log`), oracle.output);
    let caseEvidence = evidence;
    if (fault.name === 'stale-baseline') caseEvidence = { ...evidence, identity: { ...evidence.identity, tree: 'stale' } };
    if (fault.name === 'corrupt-baseline') caseEvidence = { ...evidence, input: { ...evidence.input, tests: [] } };
    const decision = select({ evidence: caseEvidence, baseRoot: base, headRoot: head, runner, runtime, config });
    const selected = decision.kind === 'refuse' ? null : execute(runner, head, decision.kind === 'full' ? [] : decision.files);
    if (selected) writeFileSync(join(logs, `${fault.name}-${decision.kind}.log`), selected.output);
    const falseGreen = oracle.outcome === 'fail' && selected?.outcome === 'pass' && decision.kind === 'selected';
    const mismatch = oracle.outcome !== fault.oracle || decision.kind !== fault.expect ||
      (selected && selected.outcome !== oracle.outcome);
    const selectedIds = input.tests.filter((test) => decision.files.includes(test.file)).map((test) => test.id).sort();
    const newFilesWithoutBaselineIds = decision.files.filter((file) => !input.tests.some((test) => test.file === file));
    const record = { runner, case: fault.name, expectedDecision: fault.expect, expectedOracle: fault.oracle,
      oracle: oracle.outcome, oracleFailures: oracle.failed, oracleWallMs: oracle.wallMs,
      decision: decision.kind, reason: decision.reason, selectedFiles: decision.files, selectedIds, newFilesWithoutBaselineIds,
      selected: selected?.outcome ?? null, selectedFailures: selected?.failed ?? null, selectedWallMs: selected?.wallMs ?? null,
      falseGreen, mismatch, diagnostic: oracle.error ?? selected?.error ?? null };
    records.push(record);
    writeFileSync(join(scratch, `results-${runner}.jsonl`), records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    rmSync(head, { recursive: true, force: true });
    if (falseGreen || mismatch) return { blocked: true, case: fault.name, reason: falseGreen ? 'false green' : 'case mismatch' };
  }
  return { blocked: false };
}

mkdirSync(scratch, { recursive: true });
for (const runner of runners) {
  const records = [];
  try {
    const result = await runRunner(runner, records);
    console.log(`${runner}: ${result.blocked ? `${result.reason} in ${result.case}` : `${cases.length} synthetic cases executed`}`);
    if (result.blocked) { process.exitCode = 1; break; }
  } catch (error) {
    records.push({ runner, phase: 'blocked', reason: error.message });
    writeFileSync(join(scratch, `results-${runner}.jsonl`), records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    console.error(`${runner}: ${error.message}`);
    process.exitCode = 1;
  }
}
