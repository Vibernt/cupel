#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { baseFiles, cases, inject, writeFiles } from '../s12/fixtures.mjs';
import { safeFileInventory } from './evidence-base.mjs';
import { captureJsDependencies } from './js-pilot/capture.mjs';
import { digest, makeBundle } from './evidence.mjs';
import { assessHeadTrace, selectS12b } from './selection.mjs';
import { collect, execute, prepare, python, runnerInfo } from './run-execute.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const scratch = join(repo, '.scratch/s12b/orchestration');
const pyPilot = join(repo, 'plans/spikes/s12b/py-pilot');
const runners = process.argv.slice(2).length ? process.argv.slice(2) : ['node', 'vitest', 'jest', 'pytest'];

function capturePython(root, files, out, binding) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: `${pyPilot}:${root}`, CUPEL_PY_PILOT_ROOT: root, CUPEL_PY_PILOT_OUT: out,
    CUPEL_PY_PILOT_EXPECTED_FILES: JSON.stringify(files),
    CUPEL_PY_PILOT_CONFIG_HASH: binding.configHash,
    CUPEL_PY_PILOT_ENV_HASH: binding.environmentPolicyHash };
  const result = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-p', 'trace_plugin', ...files],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 });
  if (!result || !result.stdout) throw new Error(`pytest capture failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

async function replay(runner) {
  const info = runnerInfo(runner);
  const logs = join(scratch, runner); mkdirSync(logs, { recursive: true });
  const baseRoot = mkdtempSync(join(logs, 'base-'));
  writeFiles(baseRoot, baseFiles(runner)); prepare(runner, baseRoot);
  const start = performance.now();
  const ordinary = execute(runner, baseRoot);
  writeFileSync(join(logs, 'baseline-full.log'), ordinary.output);
  if (ordinary.outcome !== 'pass') throw new Error(`ordinary baseline ${ordinary.outcome}`);
  const input = await collect(runner, baseRoot);
  const files = [...new Set(input.tests.map(row => row.file))].sort();
  const config = { runner, command: info.command, fixture: safeFileInventory(baseRoot) };
  const environmentPolicy = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C', secrets: 'excluded' };
  const binding = { configHash: digest(config), environmentPolicyHash: digest(environmentPolicy) };
  const sidecar = runner === 'pytest' ? capturePython(baseRoot, files, join(logs, 'baseline-sidecar.json'), binding) :
    captureJsDependencies({ runner, root: baseRoot, files, out: join(logs, 'capture'),
      version: info.version, binding }).sidecar;
  writeFileSync(join(logs, 'baseline-sidecar.json'), JSON.stringify(sidecar, null, 2) + '\n');
  const setupMs = Math.round(performance.now() - start);
  const args = { baseRoot, runner, runnerVersion: info.version,
    runtime: info.runtime, config, environmentPolicy,
    executionPolicy: runner === 'pytest' ? 'shared-process' : 'experimental-fresh-process-per-file',
    baseCommit: `scratch-tree:${digest(safeFileInventory(baseRoot))}`,
    dependencyInstall: { complete: false, runner: info.version, reason: 'installed dependency tree not fingerprinted' },
    probe: { complete: false, reason: 'actual probe source/instrumentation identity not sealed' } };
  let bundle; let baselineRefusal;
  try { bundle = makeBundle({ ...args, input, sidecar }); }
  catch (error) { baselineRefusal = error.message; }
  const records = [{ phase: 'baseline', runner, runtime: info.runtime, ordinaryWallMs: ordinary.wallMs,
    setupMs, tests: input.tests.length, files: files.length, baselineRefusal,
    unsupported: [...sidecar.global.unsupported,
      ...Object.values(sidecar.files).flatMap(row => row.unsupported)] }];
  for (const item of cases) {
    const headRoot = mkdtempSync(join(logs, `${item.name}-`));
    cpSync(baseRoot, headRoot, { recursive: true,
      filter: path => !relative(baseRoot, path).split('/').some(part =>
        ['node_modules', '.scratch', '__pycache__', '.pytest_cache'].includes(part)) });
    prepare(runner, headRoot);
    inject(headRoot, runner, item.name);
    const oracle = execute(runner, headRoot);
    writeFileSync(join(logs, `${item.name}-full.log`), oracle.output);
    let caseBundle = bundle;
    if (bundle && item.name === 'stale-baseline') caseBundle = { ...bundle,
      binding: { ...bundle.binding, tree: 'stale' } };
    if (bundle && item.name === 'corrupt-baseline') caseBundle = { ...bundle,
      core: { ...bundle.core, input: { ...bundle.core.input, tests: [] } } };
    let decision = baselineRefusal ? { kind: 'refuse', reason: baselineRefusal, files: [] } :
      selectS12b({ ...args, bundle: caseBundle, headRoot });
    const selected = decision.kind === 'refuse' ? null : execute(runner, headRoot,
      decision.kind === 'full' ? [] : decision.files);
    if (selected) writeFileSync(join(logs, `${item.name}-${decision.kind}.log`), selected.output);
    if (decision.kind === 'selected' && selected?.outcome === 'pass') {
      const headSidecar = runner === 'pytest' ? capturePython(headRoot, decision.files,
        join(logs, `${item.name}-head-sidecar.json`), binding) :
        captureJsDependencies({ runner, root: headRoot, files: decision.files,
          out: join(logs, `${item.name}-head-capture`), version: info.version, binding }).sidecar;
      const assessment = assessHeadTrace({ ...args, headRoot, decision, sidecar: headSidecar });
      if (assessment.kind === 'refuse') decision = assessment;
    }
    records.push({ case: item.name, expectedOracle: item.oracle, oracle: oracle.outcome,
      oracleFailures: oracle.failed, oracleWallMs: oracle.wallMs, decision: decision.kind,
      reason: decision.reason, selectedFiles: decision.files, selected: selected?.outcome ?? null,
      selectedWallMs: selected?.wallMs ?? null,
      falseGreen: oracle.outcome === 'fail' && selected?.outcome === 'pass' && decision.kind === 'selected',
      oracleMismatch: oracle.outcome !== item.oracle });
    rmSync(headRoot, { recursive: true, force: true });
  }
  writeFileSync(join(logs, 'results.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { runner, cases: cases.length, oracleFailures: records.filter(row => row.oracle === 'fail').length,
    oracleErrors: records.filter(row => row.oracle === 'error').length,
    oracleMismatches: records.filter(row => row.oracleMismatch).length,
    selectedExecutions: records.filter(row => row.decision === 'selected').length,
    fullRoutes: records.filter(row => row.decision === 'full').length,
    refusals: records.filter(row => row.decision === 'refuse').length,
    falseGreens: records.filter(row => row.falseGreen).length, baselineRefusal };
}

mkdirSync(scratch, { recursive: true });
let failed = false;
for (const runner of runners) {
  try {
    const summary = await replay(runner);
    console.log(JSON.stringify(summary));
    if (summary.oracleErrors || summary.oracleMismatches || summary.falseGreens) failed = true;
  } catch (error) { console.error(`${runner}: ${error.stack ?? error}`); failed = true; }
}
if (failed) process.exitCode = 1;
