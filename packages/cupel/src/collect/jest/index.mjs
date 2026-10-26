import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { scanSources } from '../vitest/sources.mjs';
import { formatLines } from '../node/lines.mjs';
import { mergeLines } from '../coverage-runs.mjs';
import { coverageOfSuite, combineJestCoverage } from './coverage.mjs';
import { identifyTests } from './identity.mjs';
import { jestSignals } from './signals.mjs';
import { executeJest, effectiveJestConfig, JestCollectorError, listJestFiles, resolveJest } from './process.mjs';

const posix = path => path.split(sep).join('/');
const sorted = (a,b) => a < b ? -1 : a > b ? 1 : 0;

function sourceFacts(root, config, log) {
  const diagnostics = [];
  const sources = scanSources(root, config.scope, log, diagnostics);
  if (diagnostics.length) throw new JestCollectorError(`Jest source scan incomplete: ${diagnostics.map(d => d.message ?? d.code).join(', ')}`);
  return sources;
}

function validateRuns(runs) {
  const expected = runs[0].tests.map(t => t.id);
  for (const run of runs.slice(1)) {
    const got = run.tests.map(t => t.id);
    if (JSON.stringify(got) !== JSON.stringify(expected)) throw new JestCollectorError('Jest test set changed between collection runs');
  }
}

function resultTests(runs) {
  return runs[0].tests.map(first => {
    const rows = runs.map(run => run.tests.find(test => test.id === first.id));
    if (rows.some(row => !row)) throw new JestCollectorError(`Jest test missing in a run: ${first.id}`);
    const status = rows.some(row => row.status === 'failed') ? 'failed' :
      rows.every(row => row.status === 'skipped') ? 'skipped' : 'passed';
    return { ...first, status,
      durationsMs: rows.map(row => row.duration), runStatuses: rows.map(row => row.status) };
  });
}

async function collectRun(root, jest, files, sources, work, label, selected, env, log) {
  const out = join(work, label);
  mkdirSync(out);
  const settings = { sources:[...sources.keys()], selected };
  const { suites, run } = await executeJest({ root, jest, out, settings, files, env });
  const byTest = new Map();
  const setup = new Map();
  for (const suite of suites) {
    const coverage = coverageOfSuite(root, suite, sources);
    setup.set(suite.file, coverage.setup);
    for (const [id, lines] of coverage.byTest) {
      if (byTest.has(id)) throw new JestCollectorError(`duplicate Jest test id ${id}`);
      byTest.set(id, lines);
    }
  }
  const tests = suites.flatMap(suite => suite.tests).sort((a,b) => sorted(a.id,b.id));
  log(`Jest ${label}: ${tests.length} tests, ${tests.filter(t => t.status === 'passed').length} passed, ${run.wallMs} ms`);
  return { suites, tests, coverage:{ byTest, setup } };
}

export async function collectJest({ root, config = {}, files, runs = 2, recheck = [], log = () => {}, diagnostics = [] } = {}) {
  if (!root) throw new JestCollectorError('collectJest: root is required');
  if (!Number.isInteger(runs) || runs < 1) throw new JestCollectorError('collectJest: runs must be a positive integer');
  root = realpathSync(resolve(root));
  const jest = resolveJest(root);
  const runner = config.runners?.jest ?? {};
  const unsupported = ['command', 'tests', 'prepare', 'project'].find(key => runner[key] !== undefined);
  if (unsupported) throw new JestCollectorError(`runners.jest.${unsupported} is not supported by the verified Jest adapter`);
  const env = { ...process.env, ...(runner.env ?? {}) };
  await effectiveJestConfig(root, jest, env);
  const requested = files?.length ? files.map(f => resolve(root, f)) : [];
  const testFiles = await listJestFiles(root, jest, requested, env);
  if (testFiles.some(path => { const rel = posix(relative(root, path)); return rel === '..' || rel.startsWith('../') || /\.m[jt]s$/.test(path); }))
    throw new JestCollectorError('Jest test file outside root or unsupported native ESM file');
  for (const file of testFiles) {
    const text = readFileSync(file, 'utf8');
    if (/^\s*\/\*\*[\s\S]*?@jest-environment(?:-options)?\b[\s\S]*?\*\//.test(text))
      throw new JestCollectorError(`Jest per-file environment docblock is unsupported: ${posix(relative(root, file))}`);
    if (/\b(?:node:)?worker_threads\b/.test(text))
      throw new JestCollectorError(`Jest worker-thread test is unsupported: ${posix(relative(root, file))}`);
  }
  const sources = sourceFacts(root, config, log);
  if (!sources.size) throw new JestCollectorError('Jest found no source files to analyse');
  mkdirSync(join(root, '.scratch'), { recursive:true });
  const work = mkdtempSync(join(root, '.scratch/cupel-jest-'));
  try {
    const collected = [];
    for (let i = 0; i < runs; i++) collected.push(await collectRun(root, jest, testFiles, sources, work, `run${i}`, null, env, log));
    validateRuns(collected);
    const raw = resultTests(collected);
    const tests = identifyTests(root, raw);
    const signals = jestSignals(root, raw, tests);
    const coverage = combineJestCoverage(collected, sources);
    const rechecked = [];
    for (let i = 0; i < recheck.length; i++) {
      const unit = recheck[i];
      const rows = tests.filter(t => (t.unit ?? t.id) === unit);
      if (!rows.length) throw new JestCollectorError(`Jest recheck unit not found: ${unit}`);
      const file = rows[0].file;
      if (rows.some(t => t.file !== file)) throw new JestCollectorError(`Jest recheck unit spans files: ${unit}`);
      const only = await collectRun(root, jest, [join(root, file)], sources, work, `recheck${i}`, rows.map(t => t.id), env, log);
      for (const row of rows) {
        const tested = only.tests.find(t => t.id === row.id);
        if (!tested || tested.status !== row.status) throw new JestCollectorError(`Jest recheck status changed for ${row.id}`);
        coverage.byTest[row.id] = Object.fromEntries([...only.coverage.byTest.get(row.id)].map(([source, lines]) => [source, formatLines(lines)]));
      }
      if (only.tests.some(t => !rows.some(row => row.id === t.id) && t.status !== 'skipped'))
        throw new JestCollectorError(`Jest recheck ran an unselected test in ${file}`);
      rechecked.push(unit);
    }
    if (rechecked.length) coverage.rechecked = rechecked.sort(sorted);
    const sourceEntries = Object.fromEntries([...sources].sort(([a],[b]) => sorted(a,b)).map(([file, fact]) =>
      [file, { coverable:formatLines(fact.an.coverable), hash:fact.hash }]));
    return { spec:'cupel-spec/1', kind:'input', runtime:{ name:'node', version:process.versions.node },
      runtimes:[{ runner:'jest', name:'node', version:process.versions.node }], sources:sourceEntries, tests, coverage,
      shapes:signals.shapes, brittleness:signals.brittleness };
  } finally { rmSync(work, { recursive:true, force:true }); }
}

export { JestCollectorError } from './process.mjs';
