// The per-test coverage preload for node:test (spike S2, method B), loaded with `node --test --import`.
//
// `node --test` passes `--import` on to each test file's process. In a process whose main module is one of the
// collector's test files, this preload:
//  - connects a `node:inspector` Session to the same process with `Session.connect()`. That opens no port and no
//    socket; `inspector.open()` is never called. It then starts V8 precise coverage (block counts) before the
//    test file is imported;
//  - registers root `before`, `beforeEach`, `afterEach` and `after` hooks, which apply to every test of the file,
//    nested ones included. Each hook takes `Profiler.takePreciseCoverage`, which returns the counts since the
//    last take and resets them, so every take is a delta;
//  - gives each delta to the leaf tests running at that moment (K3). Two or more leaves at once (concurrency)
//    all get it, so no line becomes unique to one of them. With no test running, the delta is setup: module
//    loading, file-level `before`/`after` hooks, and async work left between tests. The closing take is a
//    `t.after()` registered from `afterEach`, so the file's `afterEach` and the test's own teardown land in the
//    test;
//  - reduces every delta at once to positive character intervals of in-scope sources (intervals.mjs). Raw V8
//    data is never kept; the collector turns intervals into lines once per source;
//  - wraps child_process and worker_threads, and marks the running tests that start a node interpreter or a
//    node shim (K11): `fork`, a Worker, `node`, `process.execPath`, or a command whose file starts with a node
//    hashbang (npm, npx and similar shims), directly or through a shell;
//  - in re-check runs (`childCoverage`), points NODE_V8_COVERAGE of every child process at a directory per
//    running test, so the coverage of node children can be added to that test (K4);
//  - with a loader in play (a preload, `--loader`, `--experimental-transform-types`, `module.register`,
//    `registerHooks`, or a changed `Module._extensions` / `Module.prototype._compile`), and for every JSX script, reads
//    the exact text V8 runs the first time an in-scope script shows up (`Debugger.getScriptSource`, while the script
//    is alive). Text at the file's own offsets (the file itself, or Node's type stripping: same-offsets.mjs) keys its
//    intervals by `<rel>` as before. Text a loader made keys them by `<rel>\0<scriptId>` and is written out under
//    `scripts`, so the collector maps them through its source map. Without a loader V8 runs the file itself or
//    Node's offset-keeping type stripping, and nothing is read: the plain path is unchanged.
// At exit it writes one JSON file per process into the collector's temporary directory.
//
// The preload is inert unless CUPEL_NODE_HOOK names a config file and this process runs one of its test files,
// so node processes that tests start never load node:test from here.
// Config: { root, sources: [rel paths], jsx: [rel paths], testFiles: [real paths], out, mode: 'coverage' | 'spawns', childCoverage }
// Node 22.3+ (TestContext.fullName). Standard library only.

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { writeAtomicJson } from '../atomic-json.mjs';
import Module, { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucket, recorder } from '../assertions/recorder.mjs';
import { installNodeAssertions } from '../assertions/node.mjs';
import { promisify } from 'node:util';
import { positiveIntervals, unionIntervals, addAll } from './intervals.mjs';
import { sameOffsets } from './same-offsets.mjs';
import { WorkerdCoverage, freePort, isWorkerd, textReader, wasmIndex, watchWorkerd } from './workerd.mjs';

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const configPath = process.env.CUPEL_NODE_HOOK;
const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
const main = process.argv[1] ? real(resolve(process.argv[1])) : null;
if (config && main && config.testFiles.includes(main)) await install(config, main);

async function install(cfg, mainFile) {
  const { before, after, beforeEach, afterEach } = await import('node:test');
  const root = cfg.root;
  const sources = new Set(cfg.sources);
  const jsx = new Set(cfg.jsx ?? []);
  // Loaders, which may hand V8 text other than the file's. Preloads run before this module, so flags name them;
  // later ones are seen by the wrappers installed below and by comparing Module's handlers with these.
  const self = import.meta.url;
  const words = [...process.execArgv, ...String(process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
  let loader = words.some((w, i) => /^--(experimental-)?loader(=|$)|^--experimental-transform-types$/.test(w) ||
    (/^(--import|--require|-r)(=|$)/.test(w) && (w.includes('=') ? w.slice(w.indexOf('=') + 1) : words[i + 1]) !== self));
  const extensionHandlers = { ...Module._extensions };
  const compileHandler = Module.prototype._compile;
  const loaderInPlay = () => loader ||= Module.prototype._compile !== compileHandler ||
    Object.keys(Module._extensions).some((ext) => Module._extensions[ext] !== extensionHandlers[ext]);
  const relOf = new Map();
  const pathOf = (url) => {
    let rel = relOf.get(url);
    if (rel !== undefined) return rel;
    rel = null;
    if (url.startsWith('file:')) {
      try {
        const r = relative(root, fileURLToPath(url.replace(/[?#].*$/, ''))).split(sep).join('/');
        if (sources.has(r) || jsx.has(r)) rel = r;
      } catch { /* not a file path */ }
    }
    relOf.set(url, rel);
    return rel;
  };

  let post = null;
  let session = null;
  if (cfg.mode === 'coverage') {
    const { Session } = await import('node:inspector');
    session = new Session();
    session.connect();
    post = (method, params) => {
      // An in-process session answers synchronously; the checkpoints rely on it (checked in S2).
      let result, error, answered = false;
      session.post(method, params, (e, r) => { error = e; result = r; answered = true; });
      if (!answered) throw new Error(`${method} did not answer synchronously`);
      if (error) throw error;
      return result;
    };
    post('Profiler.enable');
    post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  }

  const tests = []; // { i, fullName, n, interp, cov: Map(rel -> intervals), ctx }
  const active = new Set();
  const seen = new Map();
  const setup = new Map();
  const childDirs = {};

  const leaves = () => {
    const all = [...active];
    return all.length < 2 ? all : all.filter((t) => !all.some((u) => u !== t && u.fullName.startsWith(`${t.fullName} > `)));
  };
  if (cfg.assertions) installNodeAssertions(recorder(root, () => leaves().map((t) => t.assertions), cfg.assertionCap));
  // Transformed scripts by V8 script id: { rel, url, source } or { rel, url, error }; `same` holds the ids whose text
  // is at the file's own offsets.
  const scripts = {};
  const scriptsSeen = new Set();
  const same = new Set();
  const fileTexts = new Map();
  const fileText = (rel) => {
    if (!fileTexts.has(rel)) { try { fileTexts.set(rel, readFileSync(join(root, rel), 'utf8')); } catch { fileTexts.set(rel, null); } }
    return fileTexts.get(rel);
  };
  const readScripts = (fresh) => {
    let enabled = false;
    try {
      post('Debugger.enable');
      enabled = true;
      for (const [id, entry] of fresh) {
        try { entry.source = post('Debugger.getScriptSource', { scriptId: id }).scriptSource; }
        catch (error) { entry.error = String(error?.message ?? error); }
      }
    } catch (error) {
      for (const [, entry] of fresh) if (entry.source === undefined) entry.error = String(error?.message ?? error);
    } finally {
      if (enabled) { try { post('Debugger.disable'); } catch { /* the texts are read */ } }
    }
  };
  const checkpoint = () => {
    if (!post) return;
    const { result } = post('Profiler.takePreciseCoverage');
    const got = new Map();
    const fresh = [];
    const reading = loaderInPlay();
    for (const s of result) {
      const rel = pathOf(s.url);
      if (!rel || scriptsSeen.has(s.scriptId)) continue;
      scriptsSeen.add(s.scriptId);
      if (reading || jsx.has(rel)) fresh.push([s.scriptId, { rel, url: s.url }]);
      else same.add(s.scriptId);
    }
    if (fresh.length) {
      readScripts(fresh);
      for (const [id, entry] of fresh) {
        if (!jsx.has(entry.rel) && entry.source !== undefined && sameOffsets(entry.source, fileText(entry.rel))) same.add(id);
        else scripts[id] = entry;
      }
    }
    for (const s of result) {
      const rel = pathOf(s.url);
      if (!rel) continue;
      const key = same.has(s.scriptId) ? rel : `${rel}\u0000${s.scriptId}`;
      const iv = positiveIntervals(s.functions);
      if (iv.length) got.set(key, unionIntervals(got.get(key), iv));
    }
    if (!got.size) return;
    const owners = leaves();
    if (!owners.length) addAll(setup, got);
    else for (const t of owners) addAll(t.cov, got);
  };
  const safe = (fn) => (...a) => { try { return fn(...a); } catch { return undefined; } };
  const safeAsync = (fn) => async (...a) => { try { return await fn(...a); } catch { return undefined; } };

  // workerd started by tests (S30, D18): deltas taken at the same boundaries.
  const workerds = new Set();
  const workerdPending = new Set();
  const workerdNotes = { started: 0, unattached: 0, transformed: 0 };
  const workerdSources = new Set();
  const recordDelta = (delta, owners) => {
    if (!delta.size) return;
    for (const rel of delta.keys()) workerdSources.add(rel);
    if (!owners.length) addAll(setup, delta);
    else for (const t of owners) addAll(t.cov, delta);
  };
  const recordLoads = (rels, owners) => { for (const t of owners) for (const rel of rels) t.loads.add(rel); };
  const workerdCheckpoint = async () => {
    await Promise.allSettled([...workerdPending]);
    if (!workerds.size) return;
    const owners = leaves();
    for (const coverage of [...workerds]) {
      recordDelta(await coverage.take().catch(() => new Map()), owners);
      recordLoads(coverage.newLoads(), owners);
    }
  };
  let wasmFiles = null;
  const wasmOf = (hash) => { wasmFiles ??= wasmIndex(root); return wasmFiles.get(hash) ?? null; };

  before(safeAsync(async () => { checkpoint(); await workerdCheckpoint(); }));
  beforeEach(safeAsync(async (t) => {
    checkpoint();
    await workerdCheckpoint();
    const fullName = t.fullName ?? t.name;
    const n = seen.get(fullName) ?? 0;
    seen.set(fullName, n + 1);
    const rec = { i: tests.length, fullName, n, interp: false, cov: new Map(), loads: new Set(), ctx: t, ...(cfg.assertions ? { assertions: bucket() } : {}) };
    tests.push(rec);
    active.add(rec);
  }));
  afterEach(safe((t) => {
    // Registered from afterEach, this t.after runs last: after the file's afterEach hooks and the test's own
    // t.after() teardown, so those land in the test (S2, checked on Node 22 and 26).
    t.after(safeAsync(async () => {
      checkpoint();
      await workerdCheckpoint();
      let rec = null;
      for (const r of active) if (r.ctx === t) rec = r;
      if (!rec) for (const r of active) if (r.fullName === (t.fullName ?? t.name)) rec = r;
      if (rec) { active.delete(rec); rec.ctx = null; }
    }));
  }));
  after(safeAsync(async () => { checkpoint(); await workerdCheckpoint(); }));

  // Child processes and workers (K11), and child coverage for re-checks (K4).
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process');
  const NODE_NAME = /^(node|nodejs)(\.exe)?$/i;
  const SHELL = /^(sh|bash|zsh|dash|ksh|ash|fish)$/;
  const PREFIX_WORDS = new Set(['exec', 'env', 'command', 'time', 'nice', 'nohup']);
  const shebangs = new Map();
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const hasNodeShebang = (file) => {
    let yes = shebangs.get(file);
    if (yes !== undefined) return yes;
    yes = false;
    try {
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(256);
      const got = readSync(fd, buf, 0, 256, 0);
      closeSync(fd);
      yes = /^#!.*\bnode(js)?\b/.test(buf.subarray(0, got).toString('utf8').split('\n')[0]);
    } catch { /* unreadable: not a shim */ }
    shebangs.set(file, yes);
    return yes;
  };
  const commandIsNode = (cmd, env, cwd) => {
    cmd = String(cmd ?? '').replace(/^['"]|['"]$/g, '');
    if (!cmd) return false;
    if (cmd === process.execPath || NODE_NAME.test(basename(cmd))) return true;
    let file = null;
    if (cmd.includes('/') || cmd.includes(sep)) file = resolve(cwd, cmd);
    else {
      for (const dir of String(env?.PATH ?? env?.Path ?? '').split(delimiter)) {
        if (dir && isFile(join(dir, cmd))) { file = join(dir, cmd); break; }
      }
    }
    return file !== null && (real(file) === real(process.execPath) || hasNodeShebang(file));
  };
  const shellRunsNode = (line, env, cwd) => {
    for (const part of String(line).split(/&&|\|\||\$\(|[;|&\n()`]/)) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      let k = 0;
      while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]) || PREFIX_WORDS.has(words[k]))) k++;
      if (k < words.length && commandIsNode(words[k], env, cwd)) return true;
    }
    return false;
  };
  const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  const optionsIndex = (fn, args) => {
    if (fn === 'exec' || fn === 'execSync') return isPlain(args[1]) ? 1 : -1;
    const k = Array.isArray(args[1]) ? 2 : 1;
    return isPlain(args[k]) ? k : -1;
  };
  const isInterpreter = (fn, args) => {
    if (fn === 'fork') return true;
    const oi = optionsIndex(fn, args);
    const opts = oi >= 0 ? args[oi] : {};
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ? (opts.cwd instanceof URL ? fileURLToPath(opts.cwd) : String(opts.cwd)) : process.cwd();
    if (fn === 'exec' || fn === 'execSync') return shellRunsNode(args[0], env, cwd);
    const file = String(args[0]);
    const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
    if (opts.shell) return shellRunsNode([file, ...argv].join(' '), env, cwd);
    if (commandIsNode(file, env, cwd)) return true;
    const base = basename(file);
    if (SHELL.test(base)) {
      const c = argv.indexOf('-c');
      return c >= 0 && argv[c + 1] !== undefined && shellRunsNode(argv[c + 1], env, cwd);
    }
    if (base === 'env') {
      const first = argv.find((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
      return first !== undefined && commandIsNode(first, env, cwd);
    }
    return false;
  };
  const noteInterpreter = () => { for (const t of leaves()) t.interp = true; };
  const childDir = () => {
    if (!cfg.childCoverage) return null;
    const owners = leaves();
    if (!owners.length) return null;
    const name = owners.map((t) => t.i).join('-');
    childDirs[name] = owners.map((t) => t.i);
    return join(cfg.childCoverage, name);
  };
  const withChildCoverage = (fn, args, call) => {
    const dir = childDir();
    if (!dir) return call(args);
    const oi = optionsIndex(fn, args);
    if (oi >= 0 && args[oi].env) {
      const copy = args.slice();
      copy[oi] = { ...args[oi], env: { ...args[oi].env, NODE_V8_COVERAGE: dir } };
      return call(copy);
    }
    // The child reads process.env while the call runs (spawning is synchronous up to the fork).
    const had = Object.hasOwn(process.env, 'NODE_V8_COVERAGE');
    const old = process.env.NODE_V8_COVERAGE;
    process.env.NODE_V8_COVERAGE = dir;
    try { return call(args); } finally { if (had) process.env.NODE_V8_COVERAGE = old; else delete process.env.NODE_V8_COVERAGE; }
  };
  const sourceText = textReader(root);
  // A module name the harness gave workerd, resolved against the test's working
  // directory (Miniflare) or the file itself. The source text is checked later.
  const scriptRel = (url) => {
    let path = String(url);
    if (path.startsWith('file:')) {
      try {
        const abs = fileURLToPath(path);
        const fromRoot = relative(root, abs).split(sep).join('/');
        path = fromRoot.startsWith('..') ? relative(process.cwd(), abs).split(sep).join('/') : fromRoot;
      } catch { return null; }
    }
    path = path.replace(/^\.?\/+/, '');
    if (!path || path.startsWith('..')) return null;
    if (sources.has(path)) return path;
    const matches = [...sources].filter((rel) => rel.endsWith(`/${path}`));
    return matches.length === 1 ? matches[0] : null;
  };
  const startWorkerd = (target, self, args) => {
    const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
    const port = freePort();
    const copy = args.slice();
    copy[1] = [...argv, `--inspector-addr=127.0.0.1:${port}`];
    const child = target.apply(self, copy);
    const coverage = new WorkerdCoverage({ port, relOf: scriptRel, sourceText, notes: workerdNotes, wasmOf });
    workerdNotes.started++;
    workerds.add(coverage);
    child.once('exit', () => workerds.delete(coverage));
    watchWorkerd(child, coverage, { owners: leaves, record: recordDelta, pending: workerdPending, recordLoads });
    return child;
  };
  for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const orig = cp[fn];
    if (typeof orig !== 'function') continue;
    const wrap = (target) => function cupelChildProcess(...args) {
      try { if (isInterpreter(fn, args)) noteInterpreter(); } catch { /* never break the test */ }
      if (fn === 'spawn' && cfg.mode === 'coverage' && Array.isArray(args[1]) && isWorkerd(args[0], args[1].map(String))) {
        return startWorkerd(target, this, args);
      }
      return withChildCoverage(fn, args, (a) => target.apply(this, a));
    };
    const wrapped = wrap(orig);
    // exec and execFile carry a custom promisified form, which calls the original directly; wrap it too.
    if (orig[promisify.custom]) Object.defineProperty(wrapped, promisify.custom, { value: wrap(orig[promisify.custom]), configurable: true });
    cp[fn] = wrapped;
  }
  const wt = require('node:worker_threads');
  const OrigWorker = wt.Worker;
  wt.Worker = class Worker extends OrigWorker {
    constructor(...args) {
      try { noteInterpreter(); } catch { /* never break the test */ }
      super(...args);
    }
  };
  for (const name of ['register', 'registerHooks']) {
    const original = Module[name];
    if (typeof original !== 'function') continue;
    Module[name] = function cupelLoaderHook(...args) { loader = true; return original.apply(this, args); };
  }
  syncBuiltinESMExports();

  process.on('exit', () => {
    try { checkpoint(); } catch { /* exiting */ }
    if (session) {
      try { post('Profiler.stopPreciseCoverage'); post('Profiler.disable'); } catch { /* exiting */ }
      try { session.disconnect(); } catch { /* exiting */ }
    }
    const body = {
      file: relative(root, mainFile).split(sep).join('/'),
      pid: process.pid,
      mode: cfg.mode,
      tests: tests.map((t) => ({ fullName: t.fullName, n: t.n, interp: t.interp, cov: Object.fromEntries(t.cov), ...(t.loads.size ? { loads: [...t.loads].sort() } : {}), ...(cfg.assertions ? { assertions: t.assertions } : {}) })),
      setup: Object.fromEntries(setup),
      childDirs,
      ...(Object.keys(scripts).length ? { scripts } : {}),
      ...(loaderInPlay() ? { loader: true } : {}),
      ...(workerdNotes.started ? { workerd: workerdNotes, workerdSources: [...workerdSources].sort() } : {}),
    };
    writeAtomicJson(join(cfg.out, `${process.pid}.json`), body);
  });
}
