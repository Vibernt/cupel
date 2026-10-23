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
//    running test, so the coverage of node children can be added to that test (K4).
// At exit it writes one JSON file per process into the collector's temporary directory.
//
// The preload is inert unless CUPEL_NODE_HOOK names a config file and this process runs one of its test files,
// so node processes that tests start never load node:test from here.
// Config: { root, sources: [rel paths], testFiles: [real paths], out, mode: 'coverage' | 'spawns', childCoverage }
// Node 22.3+ (TestContext.fullName). Standard library only.

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucket, recorder } from '../assertions/recorder.mjs';
import { installNodeAssertions } from '../assertions/node.mjs';
import { promisify } from 'node:util';
import { positiveIntervals, unionIntervals, addAll } from './intervals.mjs';

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const configPath = process.env.CUPEL_NODE_HOOK;
const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
const main = process.argv[1] ? real(resolve(process.argv[1])) : null;
if (config && main && config.testFiles.includes(main)) await install(config, main);

async function install(cfg, mainFile) {
  const { before, after, beforeEach, afterEach } = await import('node:test');
  const root = cfg.root;
  const sources = new Set(cfg.sources);
  const relOf = new Map();
  const pathOf = (url) => {
    let rel = relOf.get(url);
    if (rel !== undefined) return rel;
    rel = null;
    if (url.startsWith('file:')) {
      try {
        const r = relative(root, fileURLToPath(url.replace(/[?#].*$/, ''))).split(sep).join('/');
        if (sources.has(r)) rel = r;
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
  const checkpoint = () => {
    if (!post) return;
    const { result } = post('Profiler.takePreciseCoverage');
    const got = new Map();
    for (const s of result) {
      const rel = pathOf(s.url);
      if (!rel) continue;
      const iv = positiveIntervals(s.functions);
      if (iv.length) got.set(rel, unionIntervals(got.get(rel), iv));
    }
    if (!got.size) return;
    const owners = leaves();
    if (!owners.length) addAll(setup, got);
    else for (const t of owners) addAll(t.cov, got);
  };
  const safe = (fn) => (...a) => { try { return fn(...a); } catch { return undefined; } };

  before(safe(() => checkpoint()));
  beforeEach(safe((t) => {
    checkpoint();
    const fullName = t.fullName ?? t.name;
    const n = seen.get(fullName) ?? 0;
    seen.set(fullName, n + 1);
    const rec = { i: tests.length, fullName, n, interp: false, cov: new Map(), ctx: t, ...(cfg.assertions ? { assertions: bucket() } : {}) };
    tests.push(rec);
    active.add(rec);
  }));
  afterEach(safe((t) => {
    // Registered from afterEach, this t.after runs last: after the file's afterEach hooks and the test's own
    // t.after() teardown, so those land in the test (S2, checked on Node 22 and 26).
    t.after(safe(() => {
      checkpoint();
      let rec = null;
      for (const r of active) if (r.ctx === t) rec = r;
      if (!rec) for (const r of active) if (r.fullName === (t.fullName ?? t.name)) rec = r;
      if (rec) { active.delete(rec); rec.ctx = null; }
    }));
  }));
  after(safe(() => checkpoint()));

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
  for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const orig = cp[fn];
    if (typeof orig !== 'function') continue;
    const wrap = (target) => function cupelChildProcess(...args) {
      try { if (isInterpreter(fn, args)) noteInterpreter(); } catch { /* never break the test */ }
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
      tests: tests.map((t) => ({ fullName: t.fullName, n: t.n, interp: t.interp, cov: Object.fromEntries(t.cov), ...(cfg.assertions ? { assertions: t.assertions } : {}) })),
      setup: Object.fromEntries(setup),
      childDirs,
    };
    writeFileSync(join(cfg.out, `${process.pid}.json`), JSON.stringify(body));
  });
}
