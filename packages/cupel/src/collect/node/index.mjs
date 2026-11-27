import { writeAssertions } from '../assertions/sidecar.mjs';
// The node:test collector (M3): runs a suite with per-test coverage and returns a cupel-spec/1 input.
//
//   collectNode({ root, config, files, runs = 2, recheck = [], log }) -> Promise<input>
//
// See packages/cupel/DESIGN-M3.md ("Collector") and spec/SPEC.md sections 3, 14 (K1-K12) and 15.
//
//  1. Sources (K1, K2): JavaScript and erasable TypeScript files minus test directories, dependency
//     directories and dot-directories, narrowed by config `scope`. Each gets its coverable lines (the line
//     rule, with the shared lexer) and a sha256 hash. JSX (`.jsx`, `.tsx`) runs only through a loader the
//     project sets up (for example `--import tsx`): its coverable lines come from the project's TypeScript, and
//     it is measured only when a test loads it and every transformed script of it has an inline source map
//     back to the unchanged file. Otherwise it is listed as unmeasured, with the reason (never guessed lines).
//  2. Runs: `runs` ordinary `node --test` runs over the test files, each with the preload hook.mjs and the
//     reporter reporter.mjs. Every run takes per-test coverage (K13), so repeated collection costs a coverage
//     run each time. Each process's coverage arrives already reduced to character
//     intervals and is turned into lines and dropped file by file.
//  3. Tests (K10): ids are `file::full name`, rows share a source-title unit, tags come
//     from `[critical]`, `[standard]` and `[minor]` in titles, durations from every run, `spawnsInterpreter`
//     from the hook (K11).
//  4. Re-check (K4): each listed unit runs alone in its own process with `--test-name-pattern`; its rows'
//     coverage (plus the coverage of node children they start) replaces the shared-process coverage.
//  5. Static analysis of the test files: brittle pins (spike S6's strict detector) plus config
//     `brittleness.patterns`, and body shapes (K12).
//
// Node APIs only, no network, no dependencies. The repository is never written to: everything goes to a
// temporary directory that is removed at the end.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globMatches } from '../../engine/match.mjs';
import { isDeclarationFile } from '../../lang/js/declaration.mjs';
import { cmp } from '../../engine/order.mjs';
import { analyse, coveredLines, formatLines, unionLines } from './lines.mjs';
import { positiveIntervals, unionIntervals } from './intervals.mjs';
import { analyseTestFile, patternFindings } from './testfile.mjs';
import { collectorError } from '../error-detail.mjs';
import { causeText, skipFile } from '../skipped.mjs';
import { readWorkerJson } from '../read-json.mjs';
import { foldRuns, unstableObject } from '../coverage-runs.mjs';
import { projectTypeScript, scanJsx } from '../../lang/js/project-typescript.mjs';
import { sourceMapLines } from '../vitest/sources.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = pathToFileURL(join(HERE, 'hook.mjs')).href;
const REPORTER = pathToFileURL(join(HERE, 'reporter.mjs')).href;
const SPEC = 'cupel-spec/1';
const DEFAULT_TESTS = 'tests/**/*.test.mjs';
const SOURCE_EXT = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;
const JSX_SOURCE = /\.[jt]sx$/;
import { JSX_IN_CHILD, JSX_NOT_LOADED, JSX_NO_MAP, JSX_NO_TYPESCRIPT, JSX_UNPARSED, SOURCE_NO_MAP } from './jsx-reasons.mjs';
export { JSX_IN_CHILD, JSX_NOT_LOADED, JSX_NO_MAP, JSX_NO_TYPESCRIPT, JSX_UNPARSED, SOURCE_NO_MAP };
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__test__']);
const DEPENDENCY_DIRS = new Set(['node_modules', 'bower_components', 'jspm_packages']);
const TIER_TAG = /\[(critical|standard|minor)\]/g;
const JS_LANGUAGE = /^(js|javascript|node|nodejs|mjs|cjs|typescript|ts)$/i;

/** A collector failure: the CLI reports it with exit code 3. */
export class CollectorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectorError';
    this.exitCode = 3;
  }
}

const posix = (p) => p.split(sep).join('/');
const sortedObject = (entries) => Object.fromEntries([...entries].sort((a, b) => cmp(a[0], b[0])));

/** Files under `root` (relative, `/`-separated), skipping dot-directories, dependency directories and symlinks. */
function walk(root, skipDir = () => false, log = () => {}, diagnostics = []) {
  const out = [];
  const visit = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (!rel) throw error;
      skipFile(diagnostics, log, 'Node directory', rel, error);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!DEPENDENCY_DIRS.has(e.name) && !skipDir(e.name)) visit(join(dir, e.name), r);
      } else if (e.isFile()) out.push(r);
    }
  };
  visit(root, '');
  return out.sort(cmp);
}

export function resolveTestFiles(root, files, glob, log = () => {}, diagnostics = []) {
  if (files && files.length) {
    return [...new Set(files.flatMap((f) => {
      try {
        const abs = isAbsolute(f) ? f : join(root, f);
        if (!existsSync(abs)) throw new Error('test file not found');
        return [posix(relative(root, realpathSync(abs)))];
      } catch (error) {
        skipFile(diagnostics, log, 'Node test', f, error);
        return [];
      }
    }))].sort(cmp);
  }
  return walk(root, () => false, log, diagnostics).filter((f) => globMatches(glob, f));
}

/**
 * Sources in scope (K2): `measured` maps rel -> { an, hash }; `unmeasured` maps rel -> { hash?, reason } for sources
 * in scope whose lines this runner cannot measure (a file it could not read), listed with no coverable lines so
 * reports show them apart instead of leaving them out; `jsx` maps rel -> { hash, text, an, problem } for JSX, decided
 * after the runs (`an` from the project's TypeScript, or null with `problem` saying why). Declaration files hold no
 * code and are not sources.
 */
function scanSources(root, scope, testFiles, log, diagnostics) {
  const include = scope?.include ?? ['**'];
  const exclude = scope?.exclude ?? [];
  const measured = new Map();
  const unmeasured = new Map();
  const jsx = new Map();
  let ts;
  for (const rel of walk(root, (name) => TEST_DIRS.has(name), log, diagnostics)) {
    if (!SOURCE_EXT.test(rel) || isDeclarationFile(rel) || TEST_FILE.test(rel) || testFiles.has(rel)) continue;
    if (!include.some((g) => globMatches(g, rel)) || exclude.some((g) => globMatches(g, rel))) continue;
    let hash;
    try {
      const buf = readFileSync(join(root, rel));
      hash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
      if (JSX_SOURCE.test(rel)) {
        const text = buf.toString('utf8');
        let an = null, problem = null;
        if (ts === undefined) {
          try { ts = projectTypeScript(root); }
          catch (error) { ts = null; problem = `${JSX_NO_TYPESCRIPT}: ${causeText(error)}`; }
        }
        if (!ts) problem ??= JSX_NO_TYPESCRIPT;
        else {
          try { an = scanJsx(ts, rel, text).analysis; }
          catch (error) { problem = `${JSX_UNPARSED}: ${causeText(error)}`; }
        }
        jsx.set(rel, { hash, text, an, problem });
        continue;
      }
      measured.set(rel, { an: analyse(buf.toString('utf8'), { strict: true }), hash });
    } catch (error) {
      skipFile(diagnostics, log, 'Node', rel, error);
      unmeasured.set(rel, { ...(hash ? { hash } : {}), reason: `not read by the node:test runner: ${causeText(error)}` });
    }
  }
  return { measured, unmeasured, jsx };
}

/**
 * JSX after the runs: each JSX source becomes measured (its lines into `measured`) or unmeasured (with the reason),
 * from what the runs saw: whether any test process loaded it, and whether every transformed script mapped back.
 */
export function settleJsx(jsx, state, measured, unmeasured, log, spawnsNode = false) {
  const counted = { measured: [], notLoaded: [], other: [] };
  for (const [rel, j] of jsx) {
    const st = state.get(rel);
    // The first failure by script URL, then cause, so the reason does not depend on the order processes finished.
    const failure = firstFailure(st.failures);
    // Not loaded in a measured process, but tests start node processes (K11) or a re-check saw it in one: those
    // may have run it unseen, which is not "no test ran it".
    const reason = !st.loaded ? (st.child || spawnsNode ? JSX_IN_CHILD : JSX_NOT_LOADED)
      : j.problem ?? (failure ? `${JSX_NO_MAP}: ${failure.cause}` : null);
    if (reason) {
      unmeasured.set(rel, { hash: j.hash, reason });
      (st.loaded ? counted.other : counted.notLoaded).push(rel);
    } else {
      measured.set(rel, { an: j.an, hash: j.hash });
      counted.measured.push(rel);
    }
  }
  const list = (rels) => `${rels.slice(0, 5).join(', ')}${rels.length > 5 ? ', …' : ''}`;
  if (counted.measured.length) log(`Node: ${counted.measured.length} JSX ${counted.measured.length === 1 ? 'source' : 'sources'} measured through the project's loader and its source maps`);
  if (counted.notLoaded.length) log(`Node: ${counted.notLoaded.length} JSX ${counted.notLoaded.length === 1 ? 'source' : 'sources'} not measured, not loaded by any test (node:test runs JSX only through a loader such as --import tsx): ${list(counted.notLoaded)}`);
  if (counted.other.length) log(`Node: ${counted.other.length} JSX ${counted.other.length === 1 ? 'source' : 'sources'} loaded but not measured: ${counted.other.map((rel) => `${rel} (${unmeasured.get(rel).reason})`).slice(0, 5).join('; ')}${counted.other.length > 5 ? '; …' : ''}`);
  return new Set([...counted.notLoaded, ...counted.other]);
}

const firstFailure = (failures) => [...failures].sort((a, b) => cmp(a.url, b.url) || cmp(a.cause, b.cause))[0];

/**
 * Sources other than JSX that a loader transformed (`transformed`: rel -> failures of its scripts): one whose every
 * transformed script mapped back stays measured, its lines mapped; one with a script that did not becomes unmeasured
 * (K1, K2), its lines dropped. Returns the dropped sources.
 */
export function settleTransformed(transformed, measured, unmeasured, log) {
  const dropped = new Set();
  let mapped = 0;
  for (const [rel, failures] of [...transformed].sort(([a], [b]) => cmp(a, b))) {
    if (!failures.length) { mapped++; continue; }
    unmeasured.set(rel, { hash: measured.get(rel).hash, reason: `${SOURCE_NO_MAP}: ${firstFailure(failures).cause}` });
    measured.delete(rel);
    dropped.add(rel);
  }
  if (mapped) log(`Node: ${mapped} ${mapped === 1 ? 'source' : 'sources'} transformed by a loader, measured through ${mapped === 1 ? 'its source map' : 'their source maps'}`);
  if (dropped.size) log(`Node: ${dropped.size} ${dropped.size === 1 ? 'source' : 'sources'} transformed by a loader without a usable source map, not measured: ${[...dropped].slice(0, 5).join(', ')}${dropped.size > 5 ? ', …' : ''}`);
  return dropped;
}

/** The input's `sources`: measured ones with their coverable lines, unmeasured ones with none and their reason. */
function sourceEntries(sources, unmeasured, extra = () => ({})) {
  return sortedObject([
    ...[...sources].map(([rel, s]) => [rel, { coverable: formatLines(s.an.coverable), hash: s.hash, ...extra(rel) }]),
    ...[...unmeasured].map(([rel, u]) => [rel, { coverable: '', ...(u.hash ? { hash: u.hash } : {}), unmeasured: u.reason }]),
  ]);
}

/** Runs a command; resolves with { code, signal, ms, tail } (the last 4 kB of its output). */
function run(cmd, args, opts) {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    let tail = '';
    if (opts.detailFile) writeFileSync(opts.detailFile, '');
    const { detailFile, inherit, ...spawnOptions } = opts;
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-4096);
      if (detailFile) appendFileSync(detailFile, chunk);
    };
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', (chunk) => { keep(chunk); if (inherit) process.stdout.write(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { keep(chunk); if (inherit) process.stderr.write(chunk); });
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, ms: Date.now() - t0, tail }));
  });
}

function readResults(file, diagnostics, log, strict) {
  if (!existsSync(file)) return null;
  const results = [];
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { results.push(JSON.parse(line)); }
    catch (error) {
      if (strict) throw new CollectorError(`malformed node:test result in ${file}: ${error.message}`);
      skipFile(diagnostics, log, 'Node results', file, error);
    }
  }
  return results;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export async function collectNode({ root, config = {}, files, runs = 2, recheck = [], log = () => {}, diagnostics = [], assertionsOut, assertionCap, nodeArgs = [], inherit = false, junit, shard, subset, strict = false } = {}) {
  if (!root) throw new CollectorError('collectNode: root is required');
  root = realpathSync(resolve(root));
  runs = Math.max(1, Math.trunc(runs ?? 1));
  const runner = config?.runners?.node ?? {};
  const suiteFiles = resolveTestFiles(root, null, runner.tests ?? DEFAULT_TESTS, log, diagnostics);
  if (!suiteFiles.length && (shard || !files)) throw new CollectorError(`no test files match ${runner.tests ?? DEFAULT_TESTS} in ${root}`);
  const selected = files ? resolveTestFiles(root, files, runner.tests ?? DEFAULT_TESTS, log, diagnostics) : suiteFiles;
  const allowed = new Set(suiteFiles);
  if (strict) for (const file of selected) if (!allowed.has(file)) throw new CollectorError(`test file is not in configured suite: ${file}`);
  const testFiles = shard ? suiteFiles.filter((_, k) => k % shard.total === shard.index - 1) : selected;
  if (!testFiles.length && !shard) throw new CollectorError(`no test files match ${runner.tests ?? DEFAULT_TESTS} in ${root}`);
  const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const fileHashes = (list) => sortedObject(list.map((file) => [file, digest(readFileSync(join(root, file)))]));
  const suiteHash = shard ? digest(JSON.stringify(Object.entries(fileHashes(suiteFiles)))) : null;

  const env = { ...process.env, ...(runner.env ?? {}) };
  for (const k of ['NODE_V8_COVERAGE', 'NODE_TEST_CONTEXT', 'CUPEL_NODE_HOOK']) delete env[k];

  if (runner.prepare) {
    log(`prepare: ${runner.prepare}`);
    const p = spawnSync(runner.prepare, { cwd: root, env, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (p.status !== 0) {
      mkdirSync(join(root, '.scratch'), { recursive: true });
      const detailDir = mkdtempSync(join(root, '.scratch/cupel-node-prepare-'));
      const detail = p.stderr || p.stdout || p.error?.stack || '';
      throw new CollectorError(collectorError(`prepare failed (${p.error?.message ?? `exit ${p.status}`}): ${detail.trim().split('\n')[0]}`, detail, detailDir));
    }
  }

  const { measured: sources, unmeasured, jsx } = scanSources(root, config?.scope, new Set(testFiles), log, diagnostics);
  if (strict && diagnostics.length) throw new CollectorError(`source or test inventory is incomplete: ${diagnostics[0].file ?? diagnostics[0].cause}`);
  log(`${testFiles.length} test files, ${sources.size} sources${jsx.size ? `, ${jsx.size} JSX` : ''}${unmeasured.size ? `, ${unmeasured.size} not measured` : ''}`);
  // Per JSX source: whether a test process loaded it, and the first reason a transformed script did not map back.
  const jsxState = new Map([...jsx.keys()].map((rel) => [rel, { loaded: false, failures: [], child: false }]));
  const jsxSources = new Map([...jsx].filter(([, j]) => j.an).map(([rel, j]) => [rel, { text: j.text, an: j.an }]));
  // Other sources a loader transformed (the text V8 ran is not at the file's offsets): failures of their scripts.
  const transformed = new Map();
  // What sourceMapLines maps against: JSX, plus other sources once a transformed script of theirs shows up.
  const mapSources = new Map(jsxSources);
  const mapSourceOf = (rel) => {
    if (!mapSources.has(rel) && sources.has(rel)) {
      try { mapSources.set(rel, { text: readFileSync(join(root, rel), 'utf8'), an: sources.get(rel).an }); }
      catch { return null; }
    }
    return mapSources.get(rel) ?? null;
  };
  if (testFiles.length === 0) settleJsx(jsx, jsxState, sources, unmeasured, log);
  if (testFiles.length === 0) return {
    spec: SPEC, kind: 'input', runtime: { name: 'node', version: process.versions.node },
    sources: sourceEntries(sources, unmeasured),
    tests: [], coverage: { granularity: 'test', byTest: {}, setup: {}, ...(runs > 1 ? { unstable: {} } : {}) },
    collection: { runs, shard: { index: shard.index, total: shard.total, suite: suiteHash, files: {} } },
    brittleness: [], shapes: {},
  };

  const sourceList = [...sources.keys()];
  const jsxList = [...jsx.keys()];
  const realTestFiles = testFiles.map((f) => realpathSync(join(root, f)));
  const relOfUrl = new Map();
  const sourceOfUrl = (url) => {
    let rel = relOfUrl.get(url);
    if (rel === undefined) {
      rel = null;
      try { const r = posix(relative(root, fileURLToPath(url.replace(/[?#].*$/, '')))); if (sources.has(r)) rel = r; } catch { /* not a file */ }
      relOfUrl.set(url, rel);
    }
    return rel;
  };
  /**
   * A transformed script a test process recorded ({ rel, url, source } or { rel, url, error }), JSX or another source a
   * loader made: marks a JSX source loaded and checks once that the script's source map leads back to the file as it
   * is. Returns whether its lines can be used.
   */
  const scriptOk = (script) => {
    if (script.ok !== undefined) return script.ok;
    const isJsx = jsxState.has(script.rel);
    if (!isJsx && !sources.has(script.rel)) return (script.ok = false);
    if (isJsx) jsxState.get(script.rel).loaded = true;
    const target = isJsx ? (jsxSources.has(script.rel) ? jsxSources.get(script.rel) : null) : mapSourceOf(script.rel);
    let failure = null;
    if (typeof script.source !== 'string') failure = `the transformed script could not be read${script.error ? ` (${script.error})` : ''}`;
    else if (target) {
      const found = [];
      const mapped = sourceMapLines(root, script, [], mapSources, () => {}, found);
      if (!mapped || mapped[0] !== script.rel || mapped[1] === null) failure = found[0]?.cause ?? 'its script does not map back to the file';
    } else if (!isJsx) failure = 'the file could not be read again to map it';
    if (failure) {
      const entry = { url: String(script.url ?? ''), cause: failure };
      if (isJsx) jsxState.get(script.rel).failures.push(entry);
      else { if (!transformed.has(script.rel)) transformed.set(script.rel, []); transformed.get(script.rel).push(entry); }
    } else if (!isJsx && !transformed.has(script.rel)) transformed.set(script.rel, []);
    return (script.ok = !failure && !!target);
  };
  /** { rel: intervals } (transformed scripts keyed `rel\0scriptId`, with the process's `scripts`) -> Map rel -> lines. */
  const toLines = (cov, scripts = {}) => {
    const m = new Map();
    for (const [key, iv] of Object.entries(cov)) {
      const cut = key.indexOf('\u0000');
      if (cut >= 0) {
        const script = scripts[key.slice(cut + 1)];
        if (!script || script.rel !== key.slice(0, cut) || !scriptOk(script)) continue;
        const mapped = sourceMapLines(root, script, iv, mapSources, () => {}, []);
        if (mapped?.[1]?.length) m.set(script.rel, unionLines(m.get(script.rel) ?? [], mapped[1]));
        continue;
      }
      const rel = key;
      const s = sources.get(rel);
      if (!s) continue;
      try {
        const ls = coveredLines(s.an, iv);
        if (ls.length) m.set(rel, ls);
      } catch (error) { skipFile(diagnostics, log, 'Node coverage', rel, error); }
    }
    return m;
  };
  const addLines = (into, from) => { for (const [rel, ls] of from) into.set(rel, unionLines(into.get(rel) ?? [], ls)); };
  const lineObject = (m) => sortedObject([...m].map(([rel, ls]) => [rel, formatLines(ls)]));

  mkdirSync(join(root, '.scratch'), { recursive: true });
  const tmp = mkdtempSync(join(root, '.scratch/cupel-node-'));
  let preserveTmp = false;
  try {
    /** One `node --test` run with the hook; returns { results, hook: [per-process output], ms }. */
    const suiteRun = async (name, { mode, files: only = testFiles, pattern = null, childCoverage = false }) => {
      const out = join(tmp, name);
      mkdirSync(out, { recursive: true });
      const children = childCoverage ? join(tmp, `${name}-children`) : null;
      const hookConfig = join(tmp, `${name}.json`);
      writeFileSync(hookConfig, JSON.stringify({ root, sources: sourceList, jsx: jsxList, testFiles: realTestFiles, out, mode, childCoverage: children, assertions: !!assertionsOut && name === 'run0', assertionCap }));
      const dest = join(tmp, `${name}.ndjson`);
      const detailFile = join(tmp, `${name}-output.txt`);
      const args = ['--test', ...nodeArgs, '--import', HOOK, `--test-reporter=${REPORTER}`, `--test-reporter-destination=${dest}`];
      if (inherit && name.startsWith('run')) args.push('--test-reporter=spec', '--test-reporter-destination=stdout');
      if (junit && name === 'run0') args.push('--test-reporter=junit', `--test-reporter-destination=${junit}`);
      if (pattern) args.push(`--test-name-pattern=${pattern}`);
      const r = await run(process.execPath, [...args, ...only], { cwd: root, detailFile, inherit: inherit && name.startsWith('run'), env: { ...env, CUPEL_NODE_HOOK: hookConfig } });
      let results;
      try { results = readResults(dest, diagnostics, log, strict); }
      catch (error) {
        preserveTmp = true;
        throw new CollectorError(collectorError(error.message, readFileSync(detailFile, 'utf8'), tmp));
      }
      const summaries = new Set((results ?? []).filter((x) => x.type === 'summary').map((x) => posix(relative(root, x.file))));
      const absent = only.filter((file) => !summaries.has(file));
      const seenTests = new Map();
      const completed = new Set();
      let missingResults = null;
      for (const item of results ?? []) {
        if (item.type === 'summary') {
          if (item.counts && item.counts.tests !== (seenTests.get(item.file) ?? 0)) missingResults = item;
          completed.add(item.file);
        } else if (item.type === 'test' && !completed.has(item.file)) {
          seenTests.set(item.file, (seenTests.get(item.file) ?? 0) + 1);
        }
      }
      if (!results || (strict && (r.signal || absent.length || missingResults || (r.code !== 0 && !results.some((x) => x.status === 'failed'))))) {
        preserveTmp = true;
        throw new CollectorError(collectorError(`incomplete node --test run (${r.signal ?? `exit ${r.code}`}): ${absent.length ? `missing summary for ${absent.join(', ')}` : missingResults ? `missing results for ${missingResults.file}` : r.tail.trim().split('\n')[0]}`, readFileSync(detailFile, 'utf8'), tmp));
      }
      const hook = [];
      for (const f of readdirSync(out).sort(cmp)) {
        if (f.endsWith('.json.tmp')) {
          skipFile(diagnostics, log, 'Node hook', join(out, f), 'incomplete atomic write');
          continue;
        }
        if (!f.endsWith('.json')) continue;
        const p = join(out, f);
        const d = readWorkerJson(p, diagnostics, log, 'Node hook');
        rmSync(p);
        if (!d) continue;
        const scripts = d.scripts ?? {};
        for (const script of Object.values(scripts)) scriptOk(script);
        hook.push({
          file: d.file,
          loader: d.loader === true,
          setup: mode === 'coverage' ? toLines(d.setup, scripts) : null,
          childDirs: d.childDirs,
          workerdSources: d.workerdSources ?? [],
          workerdStarted: d.workerd?.started ?? 0,
          workerdNotes: d.workerd ?? null,
          tests: d.tests.map((t) => ({ fullName: t.fullName, n: t.n, interp: t.interp, loads: t.loads ?? [], assertions: t.assertions, lines: mode === 'coverage' ? toLines(t.cov, scripts) : null })),
        });
      }
      rmSync(out, { recursive: true, force: true });
      const childJsx = new Map();
      const childLines = children ? readChildCoverage(children, childJsx) : null;
      if (strict && diagnostics.length) {
        preserveTmp = true;
        throw new CollectorError(collectorError(`incomplete node coverage: ${diagnostics[0].file ?? diagnostics[0].cause}`, readFileSync(detailFile, 'utf8'), tmp));
      }
      return { results: results.filter((x) => x.type !== 'summary'), hook, ms: r.ms, childLines, childJsx };
    };
    /** NODE_V8_COVERAGE output of child processes, per directory name -> Map rel -> lines. Raw files are removed. */
    /** `jsxBySub` gets, per directory name, the JSX sources a child loaded (its file holds no text to map them). */
    const readChildCoverage = (dir, jsxBySub) => {
      const out = new Map();
      if (!existsSync(dir)) return out;
      const jsxInChild = new Set();
      for (const sub of readdirSync(dir)) {
        const acc = new Map();
        const subDir = join(dir, sub);
        for (const f of readdirSync(subDir)) {
          let data;
          data = readWorkerJson(join(subDir, f), diagnostics, log, 'Node child coverage');
          if (!data) continue;
          for (const sc of data.result ?? []) {
            const rel = sourceOfUrl(sc.url);
            // A child's coverage file holds no script text: a source a loader transforms there (it has a source map, or
            // the measured runs saw it transformed) cannot be mapped either.
            if (rel && (transformed.has(rel) || data['source-map-cache']?.[sc.url])) {
              jsxInChild.add(rel);
              if (!jsxBySub.has(sub)) jsxBySub.set(sub, new Set());
              jsxBySub.get(sub).add(rel);
              continue;
            }
            if (!rel) {
              // A child's coverage file holds no script text, so JSX a loader transformed there cannot be mapped.
              try {
                const r = posix(relative(root, fileURLToPath(sc.url.replace(/[?#].*$/, ''))));
                if (jsxState.has(r)) {
                  jsxInChild.add(r);
                  if (!jsxBySub.has(sub)) jsxBySub.set(sub, new Set());
                  jsxBySub.get(sub).add(r);
                }
              } catch { /* not a file */ }
              continue;
            }
            const iv = positiveIntervals(sc.functions);
            if (iv.length) acc.set(rel, unionIntervals(acc.get(rel), iv));
          }
        }
        out.set(sub, toLines(Object.fromEntries(acc)));
      }
      for (const rel of jsxInChild) if (jsxState.has(rel)) jsxState.get(rel).child = true;
      if (jsxInChild.size) log(`recheck: child processes ran transformed code whose coverage cannot be mapped (no script text): ${[...jsxInChild].sort(cmp).join(', ')}`);
      rmSync(dir, { recursive: true, force: true });
      return out;
    };

    /**
     * Leaf tests of a run, by running file. Each: { id, file, name, status, ms, callFile, line, column, path,
     * testAncestors, hookKey }. `hookKey` joins the hook's record (full name and occurrence among tests that ran).
     */
    const leafTests = (results) => {
      const byFile = new Map();
      const abs = (f) => resolve(root, f.startsWith('file:') ? fileURLToPath(f) : f);
      for (const r of results) {
        const file = posix(relative(root, abs(r.file)));
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(r);
      }
      const out = [];
      for (const [file, recs] of byFile) {
        const kinds = new Map(); // full name of a parent -> 'test' | 'suite'
        const failedParents = new Set();
        for (const r of recs) {
          if (!r.parent) continue;
          const full = [...r.path, r.name].join(' > ');
          kinds.set(full, r.type);
          if (r.type === 'test' && r.status === 'failed') failedParents.add(full);
        }
        const seen = new Map();
        const ran = new Map();
        for (const r of recs) {
          if (r.type !== 'test' || r.parent) continue;
          // node:test emits a synthetic file pass for a file with no test definitions.
          if (r.name === file && r.callFile && posix(relative(root, abs(r.callFile))) === file && r.line === 1 && r.column === 1) continue;
          const name = [...r.path, r.name].join(' > ');
          const occ = seen.get(name) ?? 0;
          seen.set(name, occ + 1);
          let hookKey = null;
          if (r.status !== 'skipped') {
            const n = ran.get(name) ?? 0;
            ran.set(name, n + 1);
            hookKey = `${name}\u0000${n}`;
          }
          const prefixes = r.path.map((_, i) => r.path.slice(0, i + 1));
          let status = r.status;
          if (status === 'passed' && prefixes.some((p) => failedParents.has(p.join(' > ')))) status = 'failed';
          out.push({
            id: `${file}::${name}${occ ? ` #${occ + 1}` : ''}`,
            file,
            name,
            status,
            ms: r.ms,
            callFile: r.callFile ? posix(relative(root, abs(r.callFile))) : null,
            callFileAbs: r.callFile ? abs(r.callFile) : null,
            line: r.line,
            column: r.column,
            path: r.path,
            leaf: r.name,
            testAncestors: prefixes.filter((p) => kinds.get(p.join(' > ')) === 'test').map((p) => p.join(' ')),
            hookKey,
          });
        }
      }
      return out;
    };
    /** Hook records by `file\0fullName\0n`; the coverage of parent tests goes to their leaf descendants. */
    const hookIndex = (hook) => {
      const idx = new Map();
      for (const h of hook) {
        const names = h.tests.map((t) => t.fullName);
        for (const t of h.tests) {
          const isParent = names.some((n) => n.startsWith(`${t.fullName} > `));
          if (isParent && t.lines) {
            for (const u of h.tests) if (u.fullName.startsWith(`${t.fullName} > `) && u.lines) addLines(u.lines, t.lines);
          }
        }
        for (const t of h.tests) idx.set(`${h.file}\u0000${t.fullName}\u0000${t.n}`, { ...t, record: h });
      }
      return idx;
    };

    // Coverage on every run is required to identify timing-dependent lines.
    const all = [];
    for (let i = 0; i < runs; i++) {
      const mode = 'coverage';
      const r = await suiteRun(`run${i}`, { mode });
      const leaves = leafTests(r.results);
      if (strict && r.results.some((x) => x.status === 'failed') && !leaves.some((x) => x.status === 'failed')) {
        preserveTmp = true;
        throw new CollectorError(collectorError(`node --test failed without a failed leaf in run ${i + 1}`, readFileSync(join(tmp, `run${i}-output.txt`), 'utf8'), tmp));
      }
      const index = hookIndex(r.hook);
      for (const t of leaves) if (strict && t.status !== 'skipped' && !index.has(`${t.file}\u0000${t.hookKey}`)) {
        preserveTmp = true;
        throw new CollectorError(collectorError(`missing hook coverage record for ${t.id} in run ${i + 1}`, readFileSync(join(tmp, `run${i}-output.txt`), 'utf8'), tmp));
      }
      log(`run ${i + 1}/${runs} (${mode}): ${leaves.length} tests, ${leaves.filter((t) => t.status === 'passed').length} passed, ${(r.ms / 1000).toFixed(1)} s`);
      all.push({ ...r, leaves, byId: new Map(leaves.map((t) => [t.id, t])), index });
    }
    const first = all[0];
    const firstIds = first.leaves.map((t) => t.id).sort(cmp).join('\n');
    for (const r of all.slice(1)) if (strict && r.leaves.map((t) => t.id).sort(cmp).join('\n') !== firstIds) {
      preserveTmp = true;
      throw new CollectorError(collectorError('test inventory changed between collection runs', '', tmp));
    }
    const unstable = new Map();

    // Tests (K10, K11) and coverage.
    const tests = new Map(); // id -> test
    for (const t of first.leaves) {
      if (tests.has(t.id)) continue;
      tests.set(t.id, { ...t, firstStatus: t.status, durationsMs: [], runStatuses: [], interp: false, loads: new Set(), lines: null });
    }
    for (const r of all) {
      for (const t of r.leaves) {
        const rec = tests.get(t.id);
        if (!rec) continue;
        rec.durationsMs.push(Math.max(0, Math.round(t.ms ?? 0)));
        rec.runStatuses.push(t.status);
        if (r !== first && t.status === 'failed') rec.status = 'failed';
        const h = t.hookKey ? r.index.get(`${t.file}\u0000${t.hookKey}`) : null;
        if (h?.interp) rec.interp = true;
        for (const rel of h?.loads ?? []) rec.loads.add(rel);
        if (r === first && h) rec.assertions = h.assertions;
      }
    }
    // Measuring inside workerd slows code under breakpoints, which can break a
    // test's own time budget. Coverage must never change results: statuses and
    // durations of files that started workerd come from one plain run of those
    // files (no breakpoints), and coverage from the measured runs.
    const workerdFiles = [...new Set(all.flatMap((r) => r.hook.filter((h) => h.workerdStarted > 0).map((h) => h.file)))].sort(cmp);
    if (workerdFiles.length) {
      const plain = await suiteRun('plain', { mode: 'spawns', files: workerdFiles });
      const plainById = new Map(leafTests(plain.results).map((t) => [t.id, t]));
      let changed = 0;
      for (const rec of tests.values()) {
        if (!workerdFiles.includes(rec.file)) continue;
        const p = plainById.get(rec.id);
        if (!p) continue;
        if (p.status !== rec.status) changed++;
        rec.status = p.status;
        rec.runStatuses = [p.status];
        rec.durationsMs = [Math.max(0, Math.round(p.ms ?? 0))];
      }
      log(`workerd: statuses and durations of ${workerdFiles.length} test files come from a plain run${changed ? `; ${changed} tests changed status only while measured` : ''}`);
    }
    const notes = all.flatMap((r) => r.hook.map((h) => h.workerdNotes).filter(Boolean));
    const sum = (key) => notes.reduce((n, x) => n + (x[key] ?? 0), 0);
    if (sum('unattached') || sum('transformed') || sum('unmatched')) {
      log(`workerd: not measured: ${sum('unattached')} workerd processes Cupel could not attach to, ${sum('transformed')} scripts not byte-for-byte a repository file (bundled or transformed), ${sum('unmatched')} scripts outside the measured sources`);
    }
    for (const rec of tests.values()) {
      const runLines = all.map((r) => {
        const t = r.byId.get(rec.id);
        return t?.hookKey ? r.index.get(`${t.file}\u0000${t.hookKey}`)?.lines : null;
      });
      rec.lines = runLines.some(Boolean) ? foldRuns(runLines, unstable) : null;
    }
    const setup = new Map(); // test file -> Map rel -> lines
    for (const file of new Set(all.flatMap((run) => run.hook.map((h) => h.file)))) {
      setup.set(file, foldRuns(all.map((run) => {
        const lines = new Map();
        for (const h of run.hook.filter((item) => item.file === file)) addLines(lines, h.setup);
        return lines;
      }), unstable));
    }

    // Units (K10): rows of one definition share its source title.
    const groups = new Map();
    for (const t of tests.values()) {
      if (!t.callFile || !t.line) continue;
      const key = `${t.file}\u0000${t.callFile}\u0000${t.line}\u0000${t.column}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const titles = new Map();
    const titleCounts = new Map();
    for (const rows of [...groups.values()].sort((a, b) => cmp(a[0].file, b[0].file) || a[0].line - b[0].line || a[0].column - b[0].column)) {
      const t = rows[0];
      if (rows.length < 2) {
        const key = `${t.file}::${[...t.path, t.leaf].join(' > ')}`;
        titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
        continue;
      }
      let unit;
      if (!titles.has(t.callFileAbs)) titles.set(t.callFileAbs, new Map(analyseTestFile(readFileSync(t.callFileAbs, 'utf8')).map((d) => [`${d.line}:${d.column}`, d.title])));
      let title = titles.get(t.callFileAbs).get(`${t.line}:${t.column}`);
      if (title == null) {
        // Never fail collection over a missing title: fall back to the first row's name, stable in source order.
        title = t.leaf;
        log(`warning: no source title found for ${t.file}:${t.line}:${t.column}; unit named after its first row`);
      }
      const key = `${t.file}::${t.callFile === t.file ? '' : `@${t.callFile}::`}${[...t.path, title].join(' > ')}`;
      const n = (titleCounts.get(key) ?? 0) + 1;
      titleCounts.set(key, n);
      unit = `${key}${n > 1 ? ` #${n}` : ''}`;
      for (const r of rows) r.unit = unit;
    }

    // Re-check (K4): each unit alone in its own process; its rows' coverage replaces the shared coverage.
    const rechecked = [];
    const wanted = [...new Set(recheck ?? [])];
    if (wanted.length) {
      const jobs = [];
      for (const u of wanted) {
        const rows = [...tests.values()].filter((t) => (t.unit ?? t.id) === u);
        if (!rows.length) { log(`recheck: unknown unit ${u}, skipped`); continue; }
        if (rows.every((t) => t.status === 'skipped')) { log(`recheck: ${u} is skipped, not re-checked`); continue; }
        const parts = new Set();
        for (const t of rows) {
          parts.add([...t.path, t.leaf].join(' '));
          for (const a of t.testAncestors) parts.add(a);
        }
        jobs.push({ u, rows, pattern: `^(?:${[...parts].map(escapeRe).join('|')})$` });
      }
      let next = 0;
      const width = Math.max(1, Math.min(jobs.length, availableParallelism() - 1));
      const worker = async () => {
        while (next < jobs.length) {
          const k = next++;
          const { u, rows, pattern } = jobs[k];
          if (rows.some((row) => row.status !== 'skipped' && !row.lines)) {
            log(`recheck: ${u} has missing suite coverage; recheck cannot supply evidence`);
            continue;
          }
          const r = await suiteRun(`recheck${k}`, { mode: 'coverage', files: [rows[0].file], pattern, childCoverage: true });
          const leaves = new Map(leafTests(r.results).map((t) => [t.id, t]));
          const index = hookIndex(r.hook);
          const byIndex = new Map(); // hook test index -> record, for child coverage
          for (const h of r.hook) h.tests.forEach((t, i) => byIndex.set(`${h.file}\u0000${i}`, t));
          // A row whose child process ran JSX has coverage this re-check cannot supply: its shared coverage stays.
          const unmapped = new Set();
          for (const h of r.hook) {
            for (const [dir, owners] of Object.entries(h.childDirs ?? {})) {
              if (r.childJsx.get(dir)?.size) for (const i of owners) { const t = byIndex.get(`${h.file}\u0000${i}`); if (t) unmapped.add(t); }
              const lines = r.childLines?.get(dir);
              if (!lines) continue;
              for (const i of owners) { const t = byIndex.get(`${h.file}\u0000${i}`); if (t?.lines) addLines(t.lines, lines); }
            }
          }
          // Every row must run alone with the result it had in the suite, or the shared coverage stays.
          const replaced = [];
          let ok = true;
          for (const row of rows) {
            const t = leaves.get(row.id);
            if (!t || t.status !== row.firstStatus) { ok = false; break; }
            if (row.firstStatus === 'skipped') continue;
            const h = t.hookKey ? index.get(`${t.file}\u0000${t.hookKey}`) : null;
            if (!h) { ok = false; break; }
            if ([...unmapped].some((x) => x.fullName === h.fullName && x.n === h.n)) {
              log(`recheck: ${u} ran JSX or transformed code in a child process, whose coverage cannot be mapped; its shared coverage is kept`);
              ok = null;
              break;
            }
            replaced.push([row, h.lines]);
          }
          if (ok === null) continue;
          if (!ok) {
            log(`recheck: ${u} did not run alone as it ran in the suite; its shared coverage is kept`);
            continue;
          }
          for (const [row, lines] of replaced) row.lines = lines;
          rechecked.push(u);
        }
      };
      await Promise.all(Array.from({ length: width }, worker));
      log(`recheck: ${rechecked.length} of ${wanted.length} units re-checked`);
    }

    // JSX: measured or not, now that every run is in; lines of an unmeasured one are never kept.
    // A child process may run JSX unseen only through a loader: count tests that start node processes only when a
    // measured test process had one in play (K11); a re-check that saw JSX in a child counts on its own.
    const loaderSeen = all.some((run) => run.hook.some((h) => h.loader));
    const dropped = settleJsx(jsx, jsxState, sources, unmeasured, log, loaderSeen && [...tests.values()].some((t) => t.interp));
    for (const rel of settleTransformed(transformed, sources, unmeasured, log)) dropped.add(rel);
    if (dropped.size) {
      const strip = (m) => { for (const rel of dropped) m?.delete(rel); };
      for (const t of tests.values()) strip(t.lines);
      for (const m of setup.values()) strip(m);
      strip(unstable);
    }

    // Static analysis of the files that define the tests: brittleness and shapes.
    const patterns = [];
    for (const p of config?.brittleness?.patterns ?? []) {
      if (p.language && !JS_LANGUAGE.test(p.language)) continue;
      try { patterns.push({ kind: p.kind, re: new RegExp(p.pattern, 'm'), deliberate: p.deliberate === true }); } catch (e) { log(`brittleness pattern skipped (${e.message}): ${p.pattern}`); }
    }
    const definitions = new Map(); // abs call file -> { src, defs: Map 'line:column' -> def } | null
    const definitionOf = (t) => {
      if (!t.callFileAbs || !t.line) return null;
      if (!definitions.has(t.callFileAbs)) {
        let entry = null;
        try {
          const src = readFileSync(t.callFileAbs, 'utf8');
          entry = { src, defs: new Map(analyseTestFile(src).map((d) => [`${d.line}:${d.column}`, d])) };
        } catch (e) { skipFile(diagnostics, log, 'Node test analysis', t.callFile, e); }
        definitions.set(t.callFileAbs, entry);
      }
      const entry = definitions.get(t.callFileAbs);
      const def = entry?.defs.get(`${t.line}:${t.column}`);
      return def ? { def, src: entry.src } : null;
    };
    const brittleness = [];
    const shapes = new Map();
    for (const t of tests.values()) {
      const found = definitionOf(t);
      if (!found) continue;
      const seen = new Set();
      for (const f of [...found.def.flags, ...patternFindings(found.src, found.def, patterns)]) {
        const key = `${f.kind}\u0000${f.line}\u0000${f.deliberate === true}`;
        if (seen.has(key)) continue;
        seen.add(key);
        brittleness.push({ test: t.id, kind: f.kind, line: f.line, ...(f.deliberate ? { deliberate: true } : {}) });
      }
      shapes.set(t.unit ?? t.id, found.def.shape);
    }
    brittleness.sort((a, b) => cmp(a.test, b.test) || cmp(a.kind, b.kind) || a.line - b.line || Number(a.deliberate === true) - Number(b.deliberate === true));

    // The input (key order as in input.schema.json).
    const ordered = [...tests.values()].sort((a, b) => cmp(a.id, b.id));
    const byTest = [];
    for (const t of ordered) if (t.lines) byTest.push([t.id, lineObject(t.lines)]);
    const coverage = {
      granularity: 'test',
      byTest: sortedObject(byTest),
      setup: sortedObject([...setup].map(([f, m]) => [f, lineObject(m)])),
    };
    if (rechecked.length) coverage.rechecked = rechecked.sort(cmp);
    if (runs > 1) coverage.unstable = unstableObject(unstable);
    const inWorkerd = new Set(all.flatMap((run) => run.hook.flatMap((h) => h.workerdSources ?? [])));
    const input = {
      spec: SPEC,
      kind: 'input',
      runtime: { name: 'node', version: process.versions.node },
      sources: sourceEntries(sources, unmeasured, (rel) => (inWorkerd.has(rel) ? { measuredIn: 'workerd' } : {})),
      tests: ordered.map((t) => {
        const tags = [...new Set([...t.name.matchAll(TIER_TAG)].map((m) => m[1]))].sort(cmp);
        return {
          id: t.id,
          file: t.file,
          name: t.name,
          ...(t.unit ? { unit: t.unit } : {}),
          ...(tags.length ? { tags } : {}),
          status: t.status,
          durationsMs: t.durationsMs,
          ...(t.runStatuses.length === all.length ? { runStatuses: t.runStatuses } : {}),
          ...(t.interp ? { spawnsInterpreter: true } : {}),
          ...(t.loads?.size ? { loads: [...t.loads].sort(cmp) } : {}),
        };
      }),
      coverage,
      collection: { runs, ...(shard ? { shard: { index: shard.index, total: shard.total, suite: suiteHash, files: fileHashes(testFiles) } } : {}), ...(subset ? { subset: { files: fileHashes(testFiles) } } : {}) },
      brittleness,
      shapes: sortedObject(shapes),
    };
    if (assertionsOut) writeAssertions(assertionsOut, input, ordered.filter((t) => t.assertions).map((t) => [t.id, t.assertions]), assertionCap);
    return input;
  } finally {
    if (!preserveTmp) rmSync(tmp, { recursive: true, force: true });
  }
}
