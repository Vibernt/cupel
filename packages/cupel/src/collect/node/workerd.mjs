// Per-test coverage of Worker code running in workerd (spike S30, decision D18).
//
// When a test that Cupel's node:test preload is measuring starts workerd (for
// example through Miniflare), this module:
//  - picks a free loopback port and adds `--inspector-addr=127.0.0.1:<port>` to
//    that one workerd command line. Nothing else about the command changes;
//  - holds workerd's control pipe (fd 3, where workerd reports readiness) until
//    V8 precise coverage is running in every workerd isolate, so no request the
//    test sends is missed;
//  - takes coverage deltas at Cupel's test boundaries, and once more just before
//    the harness kills workerd, and hands each delta to the tests running then;
//  - maps a script to a repository file only when the script's source text is
//    byte-for-byte that file, so offsets and lines are exact. Bundled or
//    transformed scripts are left out and counted.
//
// D18: this is the only Cupel file that opens a connection, and only to
// 127.0.0.1, to a workerd process started inside a test run Cupel is measuring,
// on a port given by Cupel. It never listens, never sends anything but DevTools
// Profiler/Debugger commands, and never connects elsewhere. scripts/check.mjs
// allows the connection calls in this file only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const debug = (line) => { if (process.env.CUPEL_DEBUG_WORKERD) appendFileSync(process.env.CUPEL_DEBUG_WORKERD, `${line}\n`); };
import { readFileSync, readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { unionIntervals } from './intervals.mjs';
import { functionRanges, paintHits, topLevelIntervals } from './workerd-ranges.mjs';

const LOOPBACK = '127.0.0.1';
const WAIT_MS = 15_000;

/** A workerd `serve` command line (the binary Miniflare, wrangler and the workerd package run). */
export function isWorkerd(file, argv) {
  return /^workerd(?:\.exe)?$/i.test(String(file).split(/[\\/]/).pop()) && argv.includes('serve');
}

/** A free loopback port, found synchronously (spawn wrappers cannot await). */
export function freePort() {
  const probe = spawnSync(process.execPath, ['-e',
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"],
  { encoding: 'utf8', timeout: 10_000 });
  const port = Number(probe.stdout);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`no free loopback port: ${probe.stderr}`);
  return port;
}

class Session {
  constructor(url) {
    this.url = url; this.next = 1; this.waiting = new Map();
    this.socket = new WebSocket(url);
    this.open = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      const wait = this.waiting.get(message.id);
      if (!wait) return;
      this.waiting.delete(message.id);
      if (message.error) wait.reject(new Error(message.error.message)); else wait.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const wait of this.waiting.values()) wait.reject(new Error('workerd inspector closed'));
      this.waiting.clear(); this.closed = true;
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('workerd inspector closed'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.socket.close(); } catch { /* already closed */ } }
}

async function targets(port) {
  const response = await fetch(`http://${LOOPBACK}:${port}/json/list`);
  const list = await response.json();
  // Only connect back to the address we gave workerd, whatever a target claims.
  return list.filter((t) => typeof t.webSocketDebuggerUrl === 'string')
    .map((t) => ({ id: t.id, url: `ws://${LOOPBACK}:${port}${new URL(t.webSocketDebuggerUrl).pathname}` }));
}

// Miniflare appends exactly one `//# sourceURL=` line to each module; nothing else may differ.
export function sameSource(scriptSource, fileText) {
  if (typeof fileText !== 'string') return false;
  if (scriptSource === fileText) return true;
  return scriptSource.startsWith(fileText) && /^\n\/\/# sourceURL=[^\n]*\n?$/.test(scriptSource.slice(fileText.length));
}

const DRAIN = '(() => { const s = globalThis.__cupelHits; if (!s) return "[]"; const a = [...s]; s.clear(); return JSON.stringify(a); })()';

/**
 * One workerd process. V8 precise coverage cannot start in workerd (it keeps
 * Profiler.enable for its CPU profiler), so coverage comes from never-pausing
 * conditional breakpoints at every location V8 can stop at, rebuilt into
 * V8-style intervals by workerd-ranges.mjs. Every 100 ms hit breakpoints are
 * drained and removed, so hot code stops paying for them; each take restores them.
 */
export class WorkerdCoverage {
  constructor({ port, relOf, sourceText, notes, wasmOf = () => null }) {
    this.port = port; this.relOf = relOf; this.sourceText = sourceText; this.notes = notes; this.wasmOf = wasmOf;
    this.loads = new Set(); this.reported = new Set(); this.wasmSeen = new Set();
    this.sessions = new Map(); this.points = new Map(); this.next = 0; this.window = new Set(); this.removed = new Set();
    this.timer = null;
  }

  async attach() {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      try {
        const list = await targets(this.port);
        if (list.length) {
          const loaded = await this.connect(list);
          this.timer = setInterval(() => { this.sweep().catch(() => {}); }, Number(process.env.CUPEL_WORKERD_SWEEP_MS ?? 100));
          this.timer.unref?.();
          return loaded;
        }
      } catch (error) { debug(`attach: ${error.cause?.code ?? error.message}`); }
      if (Date.now() > deadline) { this.notes.unattached++; return new Map(); }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Connects to new targets; returns the setup intervals of module top-level code that ran at startup. */
  async connect(list) {
    const loaded = new Map();
    for (const target of list) {
      if (this.sessions.has(target.id)) continue;
      const session = new Session(target.url);
      const scripts = []; const contexts = new Set();
      session.socket.addEventListener('message', (event) => {
        let m; try { m = JSON.parse(String(event.data)); } catch { return; }
        if (m.method === 'Debugger.scriptParsed') {
          session.parsed = (session.parsed ?? 0) + 1;
          if (m.params.scriptLanguage === 'WebAssembly') session.wasm.push(m.params.scriptId); else scripts.push(m.params);
        }
        if (m.method === 'Runtime.executionContextCreated') contexts.add(m.params.context.id);
        if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(m.params.executionContextId);
      });
      session.wasm = [];
      await session.open;
      session.contexts = contexts;
      await session.send('Runtime.enable');
      await session.send('Debugger.enable');
      this.sessions.set(target.id, session);
      for (const script of scripts) {
        const rel = this.relOf(script.url);
        if (!rel) continue;
        const { scriptSource } = await session.send('Debugger.getScriptSource', { scriptId: script.scriptId });
        const text = this.sourceText(rel);
        if (!sameSource(scriptSource, text)) { this.notes.transformed++; continue; }
        const ranges = functionRanges(text);
        const lines = text.split('\n').length + 1;
        const { locations } = await session.send('Debugger.getPossibleBreakpoints',
          { start: { scriptId: script.scriptId, lineNumber: 0, columnNumber: 0 }, end: { scriptId: script.scriptId, lineNumber: lines, columnNumber: 0 } });
        debug(`script ${rel}: ${locations.length} locations`);
        const info = { rel, text, ranges, locations: locations.map((l) => ({ line: l.lineNumber, column: l.columnNumber, type: l.type })), session, scriptId: script.scriptId, keys: [] };
        await Promise.all(locations.map(async (l, index) => {
          const key = this.next++;
          info.keys.push(key);
          this.points.set(key, { info, index, id: null });
          await this.place(key);
        }));
        loaded.set(rel, unionIntervals(loaded.get(rel), topLevelIntervals(text, ranges)));
        this.notes.scripts = (this.notes.scripts ?? 0) + 1;
      }
    }
    await this.resolveWasm();
    return loaded;
  }

  /** Which repository WebAssembly files the isolates loaded, matched by their bytes. */
  async resolveWasm() {
    for (const session of this.sessions.values()) {
      while (session.wasm?.length) {
        const scriptId = session.wasm.shift();
        const key = `${session.url} ${scriptId}`;
        if (this.wasmSeen.has(key)) continue;
        this.wasmSeen.add(key);
        try {
          const { bytecode } = await session.send('Debugger.getScriptSource', { scriptId });
          const rel = bytecode ? this.wasmOf(createHash('sha256').update(Buffer.from(bytecode, 'base64')).digest('hex')) : null;
          if (rel) this.loads.add(rel);
        } catch { /* the isolate may be gone */ }
      }
    }
  }

  /** Loaded artifacts not reported yet. */
  newLoads() {
    const out = [...this.loads].filter((rel) => !this.reported.has(rel));
    for (const rel of out) this.reported.add(rel);
    return out;
  }

  async place(key) {
    const point = this.points.get(key);
    const { location } = point.info.locations[point.index] ? { location: point.info.locations[point.index] } : {};
    const result = await point.info.session.send('Debugger.setBreakpoint', {
      location: { scriptId: point.info.scriptId, lineNumber: location.line, columnNumber: location.column },
      condition: `(globalThis.__cupelHits ??= new Set()).add(${key}), false`,
    });
    point.id = result.breakpointId;
  }

  /** Moves new hits into the current window and removes their breakpoints. */
  async sweep() {
    this.sweeps = (this.sweeps ?? 0) + 1;
    if (this.sweeps % 50 === 0) for (const session of this.sessions.values()) debug(`sweep ${this.sweeps}: contexts ${session.contexts.size}, scripts parsed ${session.parsed}, window ${this.window.size}`);
    for (const session of this.sessions.values()) {
      for (const contextId of session.contexts) {
        let result;
        try { ({ result } = await session.send('Runtime.evaluate', { expression: DRAIN, contextId, returnByValue: true })); } catch { continue; }
        for (const key of JSON.parse(result?.value ?? '[]')) {
          if (this.window.has(key)) continue;
          this.window.add(key);
          const point = this.points.get(key);
          if (point?.id) { session.send('Debugger.removeBreakpoint', { breakpointId: point.id }).catch(() => {}); point.id = null; this.removed.add(key); }
        }
      }
    }
  }

  /** Coverage since the last take, as Map(rel → intervals); removed breakpoints are restored. */
  async take() {
    const got = new Map();
    try { const loaded = await this.connect(await targets(this.port)); for (const [rel, iv] of loaded) got.set(rel, unionIntervals(got.get(rel), iv)); } catch { /* workerd may be exiting */ }
    await this.sweep();
    await this.resolveWasm();
    const byScript = new Map();
    for (const key of this.window) {
      const point = this.points.get(key);
      if (!point) continue;
      if (!byScript.has(point.info)) byScript.set(point.info, new Set());
      byScript.get(point.info).add(point.index);
    }
    for (const [info, hits] of byScript) got.set(info.rel, unionIntervals(got.get(info.rel), paintHits(info.text, info.ranges, info.locations, hits)));
    this.window = new Set();
    const restore = [...this.removed]; this.removed = new Set();
    await Promise.all(restore.map((key) => this.place(key).catch(() => {})));
    return got;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/**
 * Wraps one spawned workerd ChildProcess: holds its control pipe until coverage
 * runs, and takes a last delta before the harness kills it.
 * `record(delta, owners)` stores a delta for the tests that were running.
 */
export function watchWorkerd(child, coverage, { owners, record, pending, recordLoads }) {
  const control = child.stdio?.[3];
  let gate = null;
  if (control && typeof control.pipe === 'function') {
    control.pause();
    gate = new PassThrough();
    child.stdio[3] = gate;
    const destroy = gate.destroy.bind(gate);
    gate.destroy = (...args) => { control.destroy(); return destroy(...args); };
  }
  const started = owners();
  const ready = coverage.attach().then((loaded) => { record(loaded, started); recordLoads?.(coverage.newLoads(), started); })
    .finally(() => { if (gate) control.pipe(gate); });
  pending.add(ready);
  ready.finally(() => pending.delete(ready));
  const kill = child.kill.bind(child);
  let final = null;
  child.kill = (signal) => {
    if (!final) {
      const who = owners();
      final = ready.then(() => coverage.take()).then((delta) => { record(delta, who); recordLoads?.(coverage.newLoads(), who); }).catch(() => {})
        .finally(() => { coverage.close(); kill(signal); });
      pending.add(final);
      final.finally(() => pending.delete(final));
    }
    return true;
  };
  child.once('exit', () => coverage.close());
  return ready;
}

/** Reads a repository source's text, cached. */
export function textReader(root) {
  const cache = new Map();
  return (rel) => {
    if (!cache.has(rel)) { try { cache.set(rel, readFileSync(`${root}/${rel}`, 'utf8')); } catch { cache.set(rel, null); } }
    return cache.get(rel);
  };
}

/** sha256 → repository path of every .wasm file under root (outside node_modules, target and dot directories). */
export function wasmIndex(root) {
  const out = new Map();
  const walk = (dir, rel, depth) => {
    if (depth > 12) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
      const path = `${dir}/${e.name}`; const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path, r, depth + 1);
      else if (e.isFile() && e.name.endsWith('.wasm')) { try { out.set(createHash('sha256').update(readFileSync(path)).digest('hex'), r); } catch { /* unreadable */ } }
    }
  };
  walk(root, '', 0);
  return out;
}
