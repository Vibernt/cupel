// S2 method B: in-process V8 precise coverage, taken at node:test boundaries.
//
// Usage (preload; works for a plain file run and for `node --test`, which passes --import to each file's process):
//   CUPEL_S2_OUT=/abs/out/dir CUPEL_S2_ROOT=/abs/suite/root \
//     node --test --import /abs/path/plans/spikes/s2/hook.mjs tests/x.test.mjs
//   CUPEL_S2_MODE=hooks       hooks and timing only, no profiler (to separate costs)
//   CUPEL_S2_MODE=start-only  profiler on, but coverage is taken once at exit (cost of precise coverage itself)
//   CUPEL_S2_MODE=coverage    the default: take coverage at every test boundary
//   CUPEL_S2_FORMAT=lines     write covered lines per segment (lines.mjs rule) instead of raw V8 ranges
//
// How it works:
//  - Connects an inspector Session to this same process (Session.connect()). That opens no port and no socket;
//    inspector.open() is never called, and the hook records inspector.url() (undefined when no port is open).
//  - Profiler.startPreciseCoverage({ callCount: true, detailed: true }) before the test file is imported.
//  - Root-level node:test hooks from this preload apply to every test in the file, nested ones included.
//    beforeEach and afterEach each take a checkpoint with Profiler.takePreciseCoverage, which returns the
//    counts since the previous call and resets them (checked in S2), so each checkpoint is a delta.
//  - A delta is owned by the innermost tests running at that moment (leaves). If no test runs it belongs to
//    the file: 'setup' before the first test (module load, root `before`), 'between' tests, 'teardown' after.
//    If two or more leaves run at once (concurrency), the delta is marked shared and given to all of them.
//  - The closing checkpoint is a t.after() registered from our afterEach, so it runs after the file's afterEach
//    hooks and the test's own t.after() teardown: those land in the test, like the file's beforeEach code.
//    (An afterEach registered later, from the root `before`, never runs; checked on Node 26.)
//  - child_process and worker_threads calls are counted per test: coverage in those processes is invisible here.
//  - Only scripts under <root>/src/ and <root>/public/ are kept. Everything is buffered and written on exit to
//    $CUPEL_S2_OUT/b-<file>-<pid>.json.
// Standard library only. Uses: node:inspector Session (8+), node:test root hooks in a preload, TestContext.fullName
// (22.3+) and TestContext.filePath (22.6+).

import inspector from 'node:inspector';
import { before, after, beforeEach, afterEach } from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LineRule } from './lines.mjs';

const OUT = process.env.CUPEL_S2_OUT;
const ROOT = realpathSync(process.env.CUPEL_S2_ROOT || process.cwd()); // module URLs use real paths
const MODE = process.env.CUPEL_S2_MODE || 'coverage';
const FORMAT = process.env.CUPEL_S2_FORMAT || 'raw';
const KEEP = [`${pathToFileURL(ROOT).href}/src/`, `${pathToFileURL(ROOT).href}/public/`];
const now = () => Number(process.hrtime.bigint()) / 1e6;

const session = MODE === 'hooks' ? null : new inspector.Session();
const post = (method, params) => {
  // An in-process session answers synchronously; check it, because the checkpoints rely on it.
  let result, error, answered = false;
  session.post(method, params, (e, r) => { error = e; result = r; answered = true; });
  if (!answered) throw new Error(`${method} did not answer synchronously`);
  if (error) throw error;
  return result;
};
if (session) {
  session.connect();
  post('Profiler.enable');
  post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
}

const file = process.argv[1];
const segments = [];
const tests = new Map(); // key -> { key, file, name, depth, start, end, spawned }
const active = new Map(); // key -> test
const seen = new Map(); // fullName -> occurrences, for duplicate names
let last = now();
let lastCpu = process.cpuUsage();
let pendingSpawns = [];
let testsSeen = 0;
let takeMsTotal = 0;
let takes = 0;

function leaves() {
  const all = [...active.values()];
  return all.filter((t) => !all.some((u) => u !== t && u.name.startsWith(`${t.name} > `)));
}

function checkpoint(label) {
  const t0 = now();
  let scripts = [];
  let allScripts = 0;
  if (session && MODE === 'coverage') {
    const { result } = post('Profiler.takePreciseCoverage');
    allScripts = result.length;
    scripts = result.filter((s) => KEEP.some((k) => s.url.startsWith(k))).map((s) => ({ url: s.url, functions: s.functions }));
    takes++;
  }
  const t1 = now();
  takeMsTotal += t1 - t0;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const owners = leaves();
  let kind;
  if (owners.length) kind = 'test';
  else if (label === 'root-after' || label === 'exit') kind = 'teardown';
  else if (!testsSeen) kind = 'setup'; // module load and the file's root `before` hooks
  else kind = 'between'; // async work left over from the previous test, and the runner itself
  segments.push({
    seq: segments.length,
    label,
    kind,
    owners: owners.map((t) => t.key),
    shared: owners.length > 1,
    wallMs: t0 - last, // time spent in the segment itself, before this checkpoint's take
    takeMs: t1 - t0,
    cpuUserMs: cpu.user / 1000,
    cpuSysMs: cpu.system / 1000,
    allScripts,
    spawned: pendingSpawns,
    scripts,
  });
  pendingSpawns = [];
  last = now();
}

// Count child processes and worker threads, per segment and per running test.
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const orig = cp[fn];
  cp[fn] = function counted(cmd, ...rest) {
    const what = `${fn}:${basename(String(fn === 'fork' ? process.execPath : cmd)).split(' ')[0]}`;
    pendingSpawns.push(what);
    for (const t of leaves()) t.spawned.push(what);
    return orig.call(this, cmd, ...rest);
  };
}
const wt = require('node:worker_threads');
const OrigWorker = wt.Worker;
wt.Worker = class CountedWorker extends OrigWorker {
  constructor(...args) {
    pendingSpawns.push('worker');
    for (const t of leaves()) t.spawned.push('worker');
    super(...args);
  }
};
syncBuiltinESMExports();

const keyOf = (t) => {
  const fullName = t.fullName ?? t.name;
  const n = (seen.get(fullName) ?? 0);
  return { fullName, n };
};

before(() => checkpoint('root-before'));
afterEach((t) => {
  // Registered from afterEach, this t.after runs last: after the file's afterEach hooks and the test's own t.after.
  t.after(() => {
    const k = [...active.values()].find((x) => x.ctx === t) ??
      [...active.values()].reverse().find((x) => x.name === (t.fullName ?? t.name)) ?? null;
    checkpoint('end');
    if (k) { k.end = now(); active.delete(k.key); delete k.ctx; }
  });
});
beforeEach((t) => {
  checkpoint('beforeEach');
  const { fullName, n } = keyOf(t);
  seen.set(fullName, n + 1);
  const key = n ? `${fullName} #${n + 1}` : fullName;
  const rec = { key, name: fullName, file: t.filePath ?? file, depth: fullName.split(' > ').length - 1, start: now(), end: null, spawned: [], ctx: t };
  tests.set(key, rec);
  active.set(key, rec);
  testsSeen++;
});
after(() => checkpoint('root-after'));

process.on('exit', () => {
  if (!testsSeen) return;
  checkpoint('exit');
  if (session) { try { post('Profiler.stopPreciseCoverage'); post('Profiler.disable'); } catch { /* exiting */ } session.disconnect(); }
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const t0 = now();
  let processMs = null;
  if (FORMAT === 'lines') {
    // Turn each segment's ranges into covered lines here, so the output stays small (whole-suite runs).
    const rule = new LineRule(ROOT);
    for (const s of segments) {
      const sets = rule.lineSets(s.scripts);
      s.lines = Object.fromEntries([...sets].map(([p, ls]) => [p, [...ls]]));
      delete s.scripts;
    }
    processMs = now() - t0;
  }
  const body = JSON.stringify({
    file,
    pid: process.pid,
    node: process.version,
    mode: MODE,
    inspectorUrl: inspector.url() ?? null,
    takes,
    takeMsTotal,
    processMs,
    tests: [...tests.values()].map(({ ctx, ...t }) => t),
    segments,
  });
  writeFileSync(`${OUT}/b-${basename(file)}-${process.pid}.json`, body);
  // Written last, so the write's own cost is recorded too (in a separate small file).
  writeFileSync(`${OUT}/b-${basename(file)}-${process.pid}.write.json`, JSON.stringify({ writeMs: now() - t0, bytes: body.length }));
});
