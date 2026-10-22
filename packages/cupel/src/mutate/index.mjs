// Mutation for Node (M3, DESIGN-M3.md "Mutation"; SPEC 3.5, K5 to K7; decisions D5 and D6).
//
//   mutateNode({ root, config, input, scope, log }) -> Promise<mutation>
//   confirmSurvivors({ root, input, mutation, ids }) -> Promise<mutation>
//
// Mutants come from the S3 operators over the shared lexer, are filtered for validity, capped and sampled with
// `config.mutation.seed`, and served in memory by a module load hook (never written to the project). Tests are
// selected by the input's coverage. A kill needs a reported failing test (K5); a crash is re-run once, then `error`.
// Optional extras on the argument object: `jobs` (parallel processes, default at most two) and
// `timeoutFloorMs` (the least a file run may take before it counts as a timeout, default 1000), and
// `metrics` (a caller-owned counter object used by smoke tests, never part of the mutation result).

import { readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, cpus, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { effectiveConfig } from '../engine/config.mjs';
import { median } from '../engine/model.mjs';
import { anyGlobMatches } from '../engine/match.mjs';
import { lines as parseLines } from '../engine/lines.mjs';
import { cmp, sortedUnique } from '../engine/order.mjs';
import { unitOf } from '../engine/integrity.mjs';
import { generateMutants, applyMutant, sample, prng } from './operators.mjs';
import { checkValidity } from './validity.mjs';
import { enumerateSites } from './sites.mjs';
import { mutationModel } from './model.mjs';
import { EnvironmentError, testEnv, pool, runTestFile, isFileFailure } from './runner.mjs';

export { EnvironmentError } from './runner.mjs';
export { generateMutants, applyMutant, sample, OPERATORS } from './operators.mjs';

const CONFIG_SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url), 'utf8'));
const TIMEOUT_FACTOR = 3; // a mutant run may take 3x the file's baseline time
const RECHECK_FACTOR = 3; // a timed-out run is re-run once with 3x the limit (or of a fresh unmutated time, if longer)
const STOP_AFTER_FILES = 2; // spike S3: a unique kill needs exactly one killing file
const BASELINE_TIMEOUT_MS = 10 * 60 * 1000;

const noop = () => {};
const defaultJobs = () => Math.max(1, Math.min(2, (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) - 1));

/** Whether a sorted interval list holds line n. */
function hasLine(intervals, n) {
  let lo = 0, hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = intervals[mid];
    if (n < s) hi = mid - 1;
    else if (n > e) lo = mid + 1;
    else return true;
  }
  return false;
}

const intervalsOf = (lineSet) => (Array.isArray(lineSet) ? lineSet.map((n) => [n, n]).sort((a, b) => a[0] - b[0]) : parseLines(String(lineSet ?? '')));

function* each(intervals) {
  for (const [s, e] of intervals) for (let n = s; n <= e; n++) yield n;
}

/** The lines to mutate per source, from the scope (DESIGN-M3): critical sources, changed lines, targeted units. */
function scopeLines({ input, cfg, model, scope }) {
  const out = new Map();
  const add = (source, intervals) => {
    const info = model.sources.get(source);
    if (!info) return;
    if (!out.has(source)) out.set(source, new Set());
    const set = out.get(source);
    for (const n of each(intervals)) if (hasLine(info.coverable, n)) set.add(n);
  };
  if (scope?.critical) {
    for (const [path, info] of model.sources) if (info.critical) add(path, info.coverable);
  }
  for (const [path, lineSet] of Object.entries(scope?.changed ?? {})) {
    if (!model.sources.has(path)) continue;
    const ranges = intervalsOf(lineSet);
    add(path, ranges.length === 0 && (lineSet === '' || (Array.isArray(lineSet) && lineSet.length === 0)) ? model.sources.get(path).coverable : ranges);
  }
  const own = new Map();
  for (const uid of scope?.targeted ?? []) {
    const u = model.unitById.get(uid);
    if (!u) throw new TypeError(`scope.targeted: unknown unit ${JSON.stringify(uid)}`);
    own.set(uid, u.own);
    for (const [source, intervals] of u.own) add(source, intervals);
  }
  // Config scope (K2): the collector already narrowed `sources`; keep mutation inside it too.
  const include = cfg.scope?.include ?? ['**'];
  const exclude = cfg.scope?.exclude ?? [];
  for (const path of [...out.keys()]) {
    if (!anyGlobMatches(include, path) || anyGlobMatches(exclude, path) || out.get(path).size === 0) out.delete(path);
  }
  return { lines: new Map([...out].sort((a, b) => cmp(a[0], b[0]))), own };
}

/** Shared machinery of one mutation session: test selection, baselines and the kill check. */
class Session {
  constructor({ root, input, cfg, model, targetedUnits, jobs, timeoutFloorMs, log }) {
    this.root = realpathSync(root);
    this.input = input;
    this.model = model;
    this.targetedUnits = targetedUnits;
    this.jobs = jobs ?? defaultJobs();
    this.timeoutFloorMs = timeoutFloorMs ?? 1000;
    this.log = log;
    this.env = testEnv(cfg.runners?.node?.env ?? {});
    this.tmp = mkdtempSync(join(tmpdir(), 'cupel-mutate-'));
    this.tests = new Map(input.tests.map((t) => [t.id, t]));
    this.passedByFile = new Map();
    for (const t of input.tests) {
      if (t.status !== 'passed') continue;
      if (!this.passedByFile.has(t.file)) this.passedByFile.set(t.file, []);
      this.passedByFile.get(t.file).push(t);
    }
    this.baselines = new Map();
    this.deadline = Infinity; // performance.now() time when the budget (maxSeconds) ends
    this.urls = new Map();
    this.specs = 0;
  }

  close() {
    rmSync(this.tmp, { recursive: true, force: true });
  }

  /** The covering passed tests of a mutant's line, and the test files to run (coverage selection). */
  select(m) {
    const tests = [];
    for (const t of this.input.tests) {
      if (t.status !== 'passed') continue;
      const cov = this.model.byTest[t.id]?.[m.source];
      if (cov && hasLine(parseLines(cov), m.line)) tests.push(t);
    }
    const counts = new Map();
    for (const t of tests) counts.set(t.file, (counts.get(t.file) ?? 0) + 1);
    for (const index of [this.model.setup, this.model.byFile]) {
      for (const [file, cov] of index) {
        const covered = cov[m.source];
        if (covered && hasLine(parseLines(covered), m.line) && !counts.has(file) && this.passedByFile.has(file)) counts.set(file, 0);
      }
    }
    const needsFull = tests.some((t) => this.targetedUnits.has(unitOf(t)));
    return { tests, counts, needsFull };
  }

  /**
   * Orders a mutant's files: most covering tests first, then fastest by the input's durations, then path. Only
   * inputs decide the order (never a measured time), so the files that stop a mutant are the same on every run.
   */
  order(counts) {
    return [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (this.fileMs(a) - this.fileMs(b)) || cmp(a, b));
  }

  /** A test file's duration by the input: the sum of its tests' median durations (S4). */
  fileMs(file) {
    if (!this.fileDurations) {
      this.fileDurations = new Map();
      for (const t of this.input.tests) this.fileDurations.set(t.file, (this.fileDurations.get(t.file) ?? 0) + median(t.durationsMs));
    }
    return this.fileDurations.get(file) ?? 0;
  }

  /** Runs each file once unmutated: its time sets the timeout, and a crash means the environment is broken. */
  async baseline(files) {
    const todo = files.filter((f) => !this.baselines.has(f)).sort(cmp);
    await pool(todo, this.jobs, async (file) => {
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        r = await runTestFile({ root: this.root, file, env: this.env, tmp: this.tmp, timeoutMs: BASELINE_TIMEOUT_MS, stopAt: this.deadline });
        if (r.cut || !this.baselineBroken(r, file)) break;
      }
      if (r.cut) return; // out of time: mutants that need this file are not run
      if (this.baselineBroken(r, file)) {
        throw new EnvironmentError(`the unmutated run of ${file} did not complete (exit ${r.code}${r.signal ? `, ${r.signal}` : ''}${r.timedOut ? ', timed out' : ''}, ${r.results.length} tests reported): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
      }
      const failing = new Set(r.results.filter((x) => x.s === 'fail').map((x) => (x.suite ? `suite:${x.t}` : x.t)));
      if (failing.size) this.log(`mutate: ${file} fails unmutated (${[...failing].join(', ')}); those failures are not kills`);
      this.baselines.set(file, { wallMs: r.wallMs, code: r.code, failing, count: r.results.filter((x) => !x.suite).length });
    });
    // The known-good probe: the fastest file that passed cleanly unmutated.
    if (!this.probeFile) {
      const clean = [...this.baselines.keys()].filter((f) => this.baselines.get(f).failing.size === 0);
      this.probeFile = clean.sort((a, b) => (this.baselines.get(a).wallMs - this.baselines.get(b).wallMs) || cmp(a, b))[0];
    }
  }

  /** An unmutated run that crashed, timed out, reported nothing or could not load the file. */
  baselineBroken(r, file) {
    if (r.timedOut || r.signal || r.results.length === 0) return true;
    if (r.results.some((x) => x.s === 'fail' && isFileFailure(file, x) && !this.tests.has(`${file}::${x.t}`))) return true;
    return r.code !== 0 && !r.results.some((x) => x.s === 'fail');
  }

  /**
   * S3's lesson: before trusting an `error`, check a known-good file still passes unmutated. Returns true when it
   * does, false when the time budget ended first, and throws EnvironmentError when it fails.
   */
  async knownGood() {
    if (!this.probeFile) return true;
    const base = this.baselines.get(this.probeFile);
    const r = await runTestFile({ root: this.root, file: this.probeFile, env: this.env, tmp: this.tmp, timeoutMs: Math.max(TIMEOUT_FACTOR * RECHECK_FACTOR * base.wallMs, 60000), stopAt: this.deadline });
    if (r.cut) return false;
    const failing = r.results.filter((x) => x.s === 'fail').length;
    if (this.baselineBroken(r, this.probeFile) || r.code !== base.code || failing !== base.failing.size) {
      throw new EnvironmentError(`the known-good file ${this.probeFile} no longer passes unmutated (exit ${r.code}); the environment changed during the run`);
    }
    return true;
  }

  url(source) {
    if (!this.urls.has(source)) this.urls.set(source, pathToFileURL(realpathSync(join(this.root, source))).href);
    return this.urls.get(source);
  }

  /** Writes the hook's spec for a mutant (in the temporary directory, never in the project). */
  spec(m, text) {
    const k = ++this.specs;
    const path = join(this.tmp, `mutant-${k}.json`);
    const sourcePath = join(this.tmp, `source-${k}`);
    const seen = join(this.tmp, `seen-${k}`);
    writeFileSync(sourcePath, text);
    writeFileSync(path, JSON.stringify({ url: this.url(m.source), sourcePath, seen }));
    return { path, sourcePath, seen };
  }

  /** The input's test ids for a failing reporter line of `file`. */
  killersOf(file, line, base) {
    const passed = (this.passedByFile.get(file) ?? []).filter((t) => !base.failing.has(t.name));
    if (line.suite) return passed.filter((t) => t.name.startsWith(`${line.t} > `)).map((t) => t.id);
    const id = `${file}::${line.t}`;
    if (this.tests.has(id)) return passed.some((t) => t.id === id) ? [id] : [];
    if (isFileFailure(file, line)) return passed.map((t) => t.id);
    return [];
  }

  /** Classifies one run of a file: killed, timeout, crash or survived, with the killing test ids. */
  classify(file, r, base, covering) {
    // Failures that never count: tests that fail unmutated here, and tests the input does not list as passed (A1:
    // a failing or flaky test's results are not trusted).
    const untrusted = (x) => {
      if (base.failing.has(x.suite ? `suite:${x.t}` : x.t)) return true;
      const t = x.suite ? null : this.tests.get(`${file}::${x.t}`);
      return t !== undefined && t !== null && t.status !== 'passed';
    };
    const allFails = r.results.filter((x) => x.s === 'fail');
    const fails = allFails.filter((x) => !untrusted(x));
    const ignored = allFails.length - fails.length;
    const killers = new Set(fails.flatMap((x) => this.killersOf(file, x, base)));
    // A kill is a failure credited to a test the input lists as passed (K5). A failure no input test accounts for
    // (a test the input does not know, or a renamed one) is not a kill: the run counts as a crash, is re-run once,
    // then ends as error.
    const credited = killers.size > 0;
    if (fails.length && !credited) this.log(`mutate: ${file}: failures no input test accounts for: ${fails.map((x) => x.t).join(', ')}`);
    if (r.timedOut) {
      const open = [...r.started];
      for (const e of r.ended) {
        const k = open.indexOf(e);
        if (k >= 0) open.splice(k, 1);
      }
      let hung = sortedUnique(open).map((name) => `${file}::${name}`).filter((id) => this.tests.has(id));
      if (hung.length === 0) hung = covering.filter((t) => t.file === file).map((t) => t.id);
      if (hung.length === 0) hung = (this.passedByFile.get(file) ?? []).map((t) => t.id);
      for (const id of hung) killers.add(id);
      // A test that reported a failure before the time ran out is a kill in its own right (K5).
      return { kind: credited && fails.length ? 'killed' : 'timeout', killers };
    }
    if (credited) return { kind: 'killed', killers };
    if (fails.length) return { kind: 'crash', killers };
    const tested = r.results.filter((x) => !x.suite).length;
    // Exit 1 is what node:test gives for an ignored failure; any other change of exit code is a crash.
    const codeOk = r.code === base.code || (ignored > 0 && r.code === 1);
    if (r.signal || !codeOk || tested < base.count) return { kind: 'crash', killers };
    return { kind: 'survived', killers };
  }

  /** One file with one mutant: a timeout is re-run once with a longer limit, a crash is re-run once, then `error`. */
  async runFile(m, spec, file, covering) {
    const deadline = this.deadline;
    const CUT = { kind: 'cut', killers: new Set() };
    const base = this.baselines.get(file);
    const limit = Math.max(TIMEOUT_FACTOR * base.wallMs, this.timeoutFloorMs);
    const go = async (timeoutMs) => {
      const r = await runTestFile({ root: this.root, file, env: this.env, tmp: this.tmp, mutantSpec: spec.path, timeoutMs, stopAt: deadline });
      return r.cut ? CUT : this.classify(file, r, base, covering);
    };
    let out = await go(limit);
    if (out.kind === 'cut' || ((out.kind === 'timeout' || out.kind === 'crash') && performance.now() > deadline)) return CUT;
    if (out.kind === 'timeout') {
      // A timeout may be the machine, not the mutant: time the file unmutated now, under the current load, and give
      // the mutant 3x the larger of the two limits before calling it a timeout.
      const fresh = await runTestFile({ root: this.root, file, env: this.env, tmp: this.tmp, timeoutMs: BASELINE_TIMEOUT_MS, stopAt: deadline });
      if (fresh.cut) return CUT;
      if (this.baselineBroken(fresh, file)) return (await this.knownGood()) ? { kind: 'error', killers: new Set() } : CUT;
      out = await go(RECHECK_FACTOR * Math.max(limit, TIMEOUT_FACTOR * fresh.wallMs));
    }
    if (out.kind === 'crash') out = await go(limit);
    if (out.kind === 'crash') return (await this.knownGood()) ? { kind: 'error', killers: new Set() } : CUT;
    return out;
  }

  /**
   * The kill check of one mutant: its selected files, once each, stopping after 2 killing files unless a targeted
   * unit covers the mutant (then every file runs, so its kill data is exact). Returns null when the deadline cut it.
   */
  async killCheck(m, text) {
    const sel = this.select(m);
    if (sel.counts.size === 0) return { status: 'no-coverage', killedBy: [] };
    if ([...sel.counts.keys()].some((f) => !this.baselines.has(f))) return null; // the budget ended before its baseline
    const spec = this.spec(m, text);
    try {
      const outcomes = [];
      let killing = 0;
      for (const file of this.order(sel.counts)) {
        if (!sel.needsFull && killing >= STOP_AFTER_FILES) break;
        if (performance.now() > this.deadline) return null;
        const out = await this.runFile(m, spec, file, sel.tests);
        if (out.kind === 'cut') return null;
        outcomes.push(out);
        if (out.kind === 'killed' || out.kind === 'timeout') killing++;
      }
      const kinds = new Set(outcomes.map((o) => o.kind));
      const loaded = existsSync(spec.seen);
      const status = kinds.has('killed') ? 'killed' : kinds.has('timeout') ? 'timeout' : kinds.has('error') ? 'error' : loaded ? 'survived' : 'error';
      if (status === 'error' && !kinds.has('error')) this.log(`mutate: ${m.id} was never loaded by its tests; reported as error`);
      const killedBy = sortedUnique(outcomes.filter((o) => o.kind === 'killed' || o.kind === 'timeout').flatMap((o) => [...o.killers]));
      return { status, killedBy };
    } finally {
      rmSync(spec.path, { force: true });
      rmSync(spec.sourcePath, { force: true });
      rmSync(spec.seen, { force: true });
    }
  }
}

const entry = (m, r) => {
  const out = { id: m.id, source: m.source, line: m.line, operator: m.operator, status: r.status };
  if (r.killedBy.length) out.killedBy = r.killedBy;
  return out;
};

/** Whether every eligible mutant on a unit's own lines ended with a usable result. */
function targetedUnits({ own, eligible, results, skipped }) {
  const out = [];
  for (const [uid, lines] of own) {
    if ([...lines.keys()].some((s) => skipped.has(s))) continue;
    const mine = eligible.filter((m) => lines.has(m.source) && hasLine(lines.get(m.source), m.line));
    if (mine.every((m) => results.has(m.id) && results.get(m.id).status !== 'error')) out.push(uid);
  }
  return out.sort(cmp);
}

function seededOrder(items, seed) {
  const out = [...items];
  const rand = prng(seed);
  for (let k = out.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [out[k], out[j]] = [out[j], out[k]];
  }
  return out;
}

/**
 * Mutation testing of the scope's lines. Returns `input.mutation`: { mutants, targeted, seed, sampled }.
 * Throws EnvironmentError when the unmutated tests do not run cleanly.
 */
export async function mutateNode({ root, config = {}, input, scope = {}, log = noop, jobs, timeoutFloorMs, metrics }) {
  const started = performance.now();
  const cfg = effectiveConfig(config ?? {}, CONFIG_SCHEMA);
  const { maxMutants, maxSeconds, seed } = cfg.mutation;
  const deadline = started + maxSeconds * 1000;
  const model = mutationModel(input, cfg, scope?.targeted ?? []);
  const { lines, own } = scopeLines({ input, cfg, model, scope });
  const { candidates, skipped, stats } = await enumerateSites({ root, lines, log });
  if (metrics) Object.assign(metrics, { generated: stats.generated, sites: candidates.length, textBuilds: 0, valid: 0, invalid: 0, run: 0 });

  // Sampling: mutants on targeted units' own lines first, so those units can be complete; the rest fill the cap.
  const onTargeted = (m) => [...own.values()].some((o) => o.has(m.source) && hasLine(o.get(m.source), m.line));
  const first = candidates.filter(onTargeted);
  const rest = candidates.filter((m) => !onTargeted(m));
  let ordered = candidates;
  if (candidates.length > maxMutants) {
    // Keep the old seeded subset and source order when every drawn mutant is valid. Invalid draws use the
    // remaining targeted sites first, then the remaining sites, in deterministic seeded order.
    const preferred = first.length >= maxMutants
      ? sample(first, maxMutants, seed)
      : [...first, ...sample(rest, maxMutants - first.length, seed)];
    const chosen = new Set(preferred);
    ordered = [
      ...candidates.filter((m) => chosen.has(m)),
      ...seededOrder(first.filter((m) => !chosen.has(m)), seed),
      ...seededOrder(rest.filter((m) => !chosen.has(m)), seed),
    ];
  }

  const session = new Session({ root, input, cfg, model, targetedUnits: new Set(own.keys()), jobs, timeoutFloorMs, log });
  session.deadline = deadline;
  try {
    const invalid = new Set();
    const byId = new Map();
    let cursor = 0;
    while (cursor < ordered.length && byId.size < maxMutants && performance.now() < deadline) {
      const batch = ordered.slice(cursor, cursor + Math.min(session.jobs, maxMutants - byId.size));
      cursor += batch.length;
      const built = batch.map((m) => ({ m, text: applyMutant(readFileSync(join(root, m.source), 'utf8'), m) }));
      if (metrics) metrics.textBuilds += built.length;
      const validity = await checkValidity(built.map(({ m, text }) => ({ mode: m.mode, text })));
      const valid = built.filter(({ m }, k) => {
        if (validity.errors[k] === null) return true;
        invalid.add(m.id);
        if (metrics) metrics.invalid++;
        return false;
      });
      if (metrics) metrics.valid += valid.length;
      const files = new Set();
      for (const { m } of valid) for (const f of session.select(m).counts.keys()) files.add(f);
      await session.baseline([...files]);
      const results = await pool(valid, session.jobs, async ({ m, text }) => {
        if (performance.now() > deadline) return null;
        return session.killCheck(m, text);
      });
      valid.forEach(({ m }, k) => {
        if (results[k]) byId.set(m.id, results[k]);
      });
      if (metrics) metrics.run = byId.size;
      if (byId.size && byId.size % 25 === 0) log(`mutate: ${byId.size}/${maxMutants}`);
    }
    const mutants = candidates.filter((m) => byId.has(m.id)).map((m) => entry(m, byId.get(m.id)));
    const sampled = cursor < ordered.length || mutants.length < candidates.length - invalid.size;
    if (sampled) log(`mutate: sampled ${mutants.length} of ${candidates.length - invalid.size} known valid sites (seed ${seed})`);
    if (performance.now() >= deadline) log(`mutate: maxSeconds (${maxSeconds}) reached; ${ordered.length - cursor} sites not drawn`);
    log(`mutate: ${metrics?.valid ?? byId.size} valid, ${invalid.size} invalid, ${mutants.length} run with ${session.jobs} processes`);
    const targeted = targetedUnits({ own, eligible: candidates.filter((m) => !invalid.has(m.id)), results: byId, skipped });
    return { mutants, targeted, seed, sampled };
  } finally {
    session.close();
  }
}

/**
 * K7: re-runs the given survived mutants twice more and keeps `survived` only when they survive every time.
 * A detection in a re-run replaces the status and `killedBy`; a re-run that ends in `error` makes the mutant `error`
 * and drops the targeted units whose own lines hold it. Mutants not `survived` are left as they are.
 */
export async function confirmSurvivors({ root, input, mutation, ids, config = {}, log = noop, jobs, timeoutFloorMs }) {
  const cfg = effectiveConfig(config ?? {}, CONFIG_SCHEMA);
  const model = mutationModel(input, cfg, mutation.targeted ?? []);
  const index = new Map(mutation.mutants.map((m, k) => [m.id, k]));
  for (const id of ids) if (!index.has(id)) throw new TypeError(`confirmSurvivors: ${JSON.stringify(id)} is not in mutation.mutants`);
  const todo = sortedUnique(ids).filter((id) => mutation.mutants[index.get(id)].status === 'survived');
  const out = { ...mutation, mutants: mutation.mutants.map((m) => ({ ...m })) };
  if (todo.length === 0) return out;

  // Regenerate each mutant from the current source; a changed source no longer has the same ids.
  const generated = new Map();
  const mutants = todo.map((id) => {
    const source = mutation.mutants[index.get(id)].source;
    if (!generated.has(source)) {
      const text = readFileSync(join(root, source), 'utf8');
      generated.set(source, new Map(generateMutants(source, text).map((m) => [m.id, { ...m, text }])));
    }
    const m = generated.get(source).get(id);
    if (!m) throw new Error(`confirmSurvivors: ${id} cannot be regenerated; ${source} changed since the mutation run`);
    return m;
  });

  const targetedIds = new Set(mutation.targeted ?? []);
  const session = new Session({ root, input, cfg, model, targetedUnits: targetedIds, jobs, timeoutFloorMs, log });
  try {
    const files = new Set();
    for (const m of mutants) for (const f of session.select(m).counts.keys()) files.add(f);
    await session.baseline([...files]);
    const results = await pool(mutants, session.jobs, async (m) => {
      let last = { status: 'survived', killedBy: [] };
      for (let rep = 0; rep < 2; rep++) {
        last = await session.killCheck(m, applyMutant(m.text, m));
        if (last.status !== 'survived') break;
      }
      return last;
    });
    const errored = [];
    mutants.forEach((m, k) => {
      const r = results[k];
      if (r.status === 'survived') return;
      log(`mutate: ${m.id} did not survive a re-run: ${r.status}`);
      out.mutants[index.get(m.id)] = entry(m, r);
      if (r.status === 'error') errored.push(m);
    });
    if (out.targeted && errored.length) {
      out.targeted = out.targeted.filter((uid) => {
        const own = model.unitById.get(uid)?.own;
        return !own || !errored.some((m) => own.has(m.source) && hasLine(own.get(m.source), m.line));
      });
    }
    return out;
  } finally {
    session.close();
  }
}
