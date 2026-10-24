import { writeAssertions } from '../assertions/sidecar.mjs';
// The node:test collector (M3): runs a suite with per-test coverage and returns a cupel-spec/1 input.
//
//   collectNode({ root, config, files, runs = 2, recheck = [], log }) -> Promise<input>
//
// See packages/cupel/DESIGN-M3.md ("Collector") and spec/SPEC.md sections 3, 14 (K1-K12) and 15.
//
//  1. Sources (K1, K2): every .js, .mjs and .cjs file of the repository minus test directories, dependency
//     directories and dot-directories, narrowed by config `scope`. Each gets its coverable lines (the line
//     rule, with the shared lexer) and a sha256 hash.
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
import { cmp } from '../../engine/order.mjs';
import { analyse, coveredLines, formatLines, unionLines } from './lines.mjs';
import { positiveIntervals, unionIntervals } from './intervals.mjs';
import { analyseTestFile, patternFindings } from './testfile.mjs';
import { collectorError } from '../error-detail.mjs';
import { skipFile } from '../skipped.mjs';
import { readWorkerJson } from '../read-json.mjs';
import { foldRuns, unstableObject } from '../coverage-runs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = pathToFileURL(join(HERE, 'hook.mjs')).href;
const REPORTER = pathToFileURL(join(HERE, 'reporter.mjs')).href;
const SPEC = 'cupel-spec/1';
const DEFAULT_TESTS = 'tests/**/*.test.mjs';
const SOURCE_EXT = /\.(mjs|cjs|js)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?js$/;
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

function resolveTestFiles(root, files, glob, log, diagnostics) {
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

/** Sources in scope (K2): Map rel -> { an, hash }. */
function scanSources(root, scope, testFiles, log, diagnostics) {
  const include = scope?.include ?? ['**'];
  const exclude = scope?.exclude ?? [];
  const out = new Map();
  for (const rel of walk(root, (name) => TEST_DIRS.has(name), log, diagnostics)) {
    if (!SOURCE_EXT.test(rel) || TEST_FILE.test(rel) || testFiles.has(rel)) continue;
    if (!include.some((g) => globMatches(g, rel)) || exclude.some((g) => globMatches(g, rel))) continue;
    try {
      const buf = readFileSync(join(root, rel));
      out.set(rel, { an: analyse(buf.toString('utf8'), { strict: true }), hash: `sha256:${createHash('sha256').update(buf).digest('hex')}` });
    } catch (error) { skipFile(diagnostics, log, 'Node', rel, error); }
  }
  return out;
}

/** Runs a command; resolves with { code, signal, ms, tail } (the last 4 kB of its output). */
function run(cmd, args, opts) {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    let tail = '';
    if (opts.detailFile) writeFileSync(opts.detailFile, '');
    const { detailFile, ...spawnOptions } = opts;
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-4096);
      if (detailFile) appendFileSync(detailFile, chunk);
    };
    const child = spawn(cmd, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, ms: Date.now() - t0, tail }));
  });
}

function readResults(file, diagnostics, log) {
  if (!existsSync(file)) return null;
  const results = [];
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { results.push(JSON.parse(line)); }
    catch (error) { skipFile(diagnostics, log, 'Node results', file, error); }
  }
  return results;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export async function collectNode({ root, config = {}, files, runs = 2, recheck = [], log = () => {}, diagnostics = [], assertionsOut, assertionCap } = {}) {
  if (!root) throw new CollectorError('collectNode: root is required');
  root = realpathSync(resolve(root));
  runs = Math.max(1, Math.trunc(runs ?? 1));
  const runner = config?.runners?.node ?? {};
  const testFiles = resolveTestFiles(root, files, runner.tests ?? DEFAULT_TESTS, log, diagnostics);
  if (!testFiles.length) throw new CollectorError(`no test files match ${runner.tests ?? DEFAULT_TESTS} in ${root}`);

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

  const sources = scanSources(root, config?.scope, new Set(testFiles), log, diagnostics);
  log(`${testFiles.length} test files, ${sources.size} sources`);

  const sourceList = [...sources.keys()];
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
  /** { rel: intervals } -> Map rel -> ascending lines. */
  const toLines = (cov) => {
    const m = new Map();
    for (const [rel, iv] of Object.entries(cov)) {
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
      writeFileSync(hookConfig, JSON.stringify({ root, sources: sourceList, testFiles: realTestFiles, out, mode, childCoverage: children, assertions: !!assertionsOut && name === 'run0', assertionCap }));
      const dest = join(tmp, `${name}.ndjson`);
      const detailFile = join(tmp, `${name}-output.txt`);
      const args = ['--test', '--import', HOOK, `--test-reporter=${REPORTER}`, `--test-reporter-destination=${dest}`];
      if (pattern) args.push(`--test-name-pattern=${pattern}`);
      const r = await run(process.execPath, [...args, ...only], { cwd: root, detailFile, env: { ...env, CUPEL_NODE_HOOK: hookConfig } });
      const results = readResults(dest, diagnostics, log);
      if (!results) {
        preserveTmp = true;
        throw new CollectorError(collectorError(`node --test did not run (${r.signal ?? `exit ${r.code}`}): ${r.tail.trim().split('\n')[0]}`, readFileSync(detailFile, 'utf8'), tmp));
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
        hook.push({
          file: d.file,
          setup: mode === 'coverage' ? toLines(d.setup) : null,
          childDirs: d.childDirs,
          tests: d.tests.map((t) => ({ fullName: t.fullName, n: t.n, interp: t.interp, assertions: t.assertions, lines: mode === 'coverage' ? toLines(t.cov) : null })),
        });
      }
      rmSync(out, { recursive: true, force: true });
      const childLines = children ? readChildCoverage(children) : null;
      return { results, hook, ms: r.ms, childLines };
    };
    /** NODE_V8_COVERAGE output of child processes, per directory name -> Map rel -> lines. Raw files are removed. */
    const readChildCoverage = (dir) => {
      const out = new Map();
      if (!existsSync(dir)) return out;
      for (const sub of readdirSync(dir)) {
        const acc = new Map();
        const subDir = join(dir, sub);
        for (const f of readdirSync(subDir)) {
          let data;
          data = readWorkerJson(join(subDir, f), diagnostics, log, 'Node child coverage');
          if (!data) continue;
          for (const sc of data.result ?? []) {
            const rel = sourceOfUrl(sc.url);
            if (!rel) continue;
            const iv = positiveIntervals(sc.functions);
            if (iv.length) acc.set(rel, unionIntervals(acc.get(rel), iv));
          }
        }
        out.set(sub, toLines(Object.fromEntries(acc)));
      }
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
      log(`run ${i + 1}/${runs} (${mode}): ${leaves.length} tests, ${leaves.filter((t) => t.status === 'passed').length} passed, ${(r.ms / 1000).toFixed(1)} s`);
      all.push({ ...r, leaves, index: hookIndex(r.hook) });
    }
    const first = all[0];
    const unstable = new Map();

    // Tests (K10, K11) and coverage.
    const tests = new Map(); // id -> test
    for (const t of first.leaves) {
      if (tests.has(t.id)) continue;
      tests.set(t.id, { ...t, firstStatus: t.status, durationsMs: [], interp: false, lines: null });
    }
    for (const r of all) {
      for (const t of r.leaves) {
        const rec = tests.get(t.id);
        if (!rec) continue;
        rec.durationsMs.push(Math.max(0, Math.round(t.ms ?? 0)));
        if (r !== first && t.status === 'failed') rec.status = 'failed';
        const h = t.hookKey ? r.index.get(`${t.file}\u0000${t.hookKey}`) : null;
        if (h?.interp) rec.interp = true;
        if (r === first && h) rec.assertions = h.assertions;
      }
    }
    for (const rec of tests.values()) {
      const runLines = all.map((r) => rec.hookKey ? r.index.get(`${rec.file}\u0000${rec.hookKey}`)?.lines : null);
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
          for (const h of r.hook) {
            for (const [dir, owners] of Object.entries(h.childDirs ?? {})) {
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
            replaced.push([row, h.lines]);
          }
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
    const input = {
      spec: SPEC,
      kind: 'input',
      runtime: { name: 'node', version: process.versions.node },
      sources: sortedObject([...sources].map(([rel, s]) => [rel, { coverable: formatLines(s.an.coverable), hash: s.hash }])),
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
          ...(t.interp ? { spawnsInterpreter: true } : {}),
        };
      }),
      coverage,
      brittleness,
      shapes: sortedObject(shapes),
    };
    if (assertionsOut) writeAssertions(assertionsOut, input, ordered.filter((t) => t.assertions).map((t) => [t.id, t.assertions]), assertionCap);
    return input;
  } finally {
    if (!preserveTmp) rmSync(tmp, { recursive: true, force: true });
  }
}
