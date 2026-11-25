// Cupel's own Rust fault runner (`runners.cargo.mutants.backend: "cupel"`, D21).
//
// The faults are cargo-mutants' own (`cargo mutants --list --json`), so ids, rows and
// catch credit are the same as with the cargo-mutants backend (attributeOutcomes is shared).
// What differs is how each fault is tested:
//   B  only the test targets holding a passed test that runs the faulty line are built and
//      run, and inside them only those tests (by exact name);
//   A  those targets run most-relevant and fastest first, and a fault stops once two
//      targets caught it, unless a targeted unit covers it (then all run, as in JS);
//   C  faults the rewriter is certain about are compiled into ONE build, each switched on
//      by the CUPEL_FAULT environment variable (schemata.mjs); with every switch off the
//      covering tests must pass exactly as unmodified, or no switch is used. Every other
//      fault gets its own incremental build (the A+B path).
// All builds and runs happen in a copy of the project with its own target folder: by default a persistent
// session (session.mjs) kept between runs, with `"session": false` a throwaway scratch copy.

import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { effectiveConfig } from '../engine/config.mjs';
import { cmp } from '../engine/order.mjs';
import { copyProject } from '../mutate/index.mjs';
import { attributeOutcomes, baseRow, CargoMutantsError, mutantId, targetedUnits } from './import.mjs';
import { parseLog } from './logs.mjs';
import { environmentFor, execute, findTool, INSTALL, planCargoMutants, planEntries, slicePlan, wantedLines } from './run.mjs';
import { DEFAULT_CAP_GB, enforceCap, hashFile, openSession, sessionId } from './session.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url), 'utf8'));
const noop = () => {};
const cupelVersion = () => JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const refuse = (message) => { throw new CargoMutantsError(message); };
const TIMEOUT_FACTOR = 3;
const TIMEOUT_FLOOR_MS = 10_000;
const STOP_AFTER_TARGETS = 2;

const toPosix = (p) => p.split(sep).join('/');
const expand = (spec) => (spec ?? '').split(',').filter(Boolean).flatMap((part) => {
  const [a, b = a] = part.split('-').map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
});

/** Runs a command; stdout and stderr go to one text in arrival order. Kills the process group on timeout. */
function run(command, args, { cwd, env, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let text = ''; let stdout = ''; let timedOut = false;
    child.stdout.on('data', (c) => { text += c; stdout += c; });
    child.stderr.on('data', (c) => { text += c; });
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }, timeoutMs) : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(new CargoMutantsError(`${command}: ${e.message}`)); });
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ code, signal, timedOut, text, stdout, ms: performance.now() - started }); });
  });
}

/** The libtest name of a Cupel Rust test id (`file::a > b` → `a::b`). */
const libtestName = (test) => test.id.slice(test.file.length + 2).split(' > ').join('::');

/**
 * The named tests that reported no result in a run (`test <name> ... ok|FAILED|ignored`). A run
 * that executed none of them (an `--exact` filter that matched nothing, a binary that died
 * silently) must never be read as "nothing failed".
 */
export function missingResults(parsed, names) {
  const seen = new Set((parsed?.runs ?? []).flatMap((x) => x.reported ?? []));
  return { missing: [...names].filter((n) => !seen.has(n)).sort(cmp) };
}

/** The cargo target that holds a test file's tests: { pkg, kind, name, flags }. */
export function targetOf(file, packages) {
  const owners = packages.filter((p) => p.dir === '' || file.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length);
  for (const p of owners) {
    for (const t of p.targets) {
      if (!t.kind.includes('test')) continue;
      // An integration test with modules: tests/it/main.rs and tests/it/*.rs are one target.
      const folder = t.src.endsWith('/main.rs') ? `${dirname(t.src)}/` : null;
      if (t.src === file || (folder && file.startsWith(folder))) return { pkg: p.name, kind: 'test', name: t.name, flags: ['--test', t.name] };
    }
    const src = p.dir ? `${p.dir}/src/` : 'src/';
    for (const t of p.targets) {
      if (!t.kind.includes('bin')) continue;
      // A program's own file, or a module under its folder (src/bin/<name>/main.rs).
      const folder = t.src.startsWith(`${src}bin/`) && t.src.endsWith('/main.rs') ? `${dirname(t.src)}/` : null;
      if (t.src === file || (folder && file.startsWith(folder))) return { pkg: p.name, kind: 'bin', name: t.name, flags: ['--bin', t.name] };
    }
    const lib = p.targets.find((t) => t.kind.some((k) => ['lib', 'rlib', 'proc-macro', 'cdylib', 'staticlib', 'dylib'].includes(k)));
    if (lib && file.startsWith(src) && !file.startsWith(`${src}bin/`) && file !== `${src}main.rs`) return { pkg: p.name, kind: 'lib', name: lib.name, flags: ['--lib'] };
    const main = p.targets.find((t) => t.kind.includes('bin') && t.src === `${src}main.rs`);
    if (main && file.startsWith(src)) return { pkg: p.name, kind: 'bin', name: main.name, flags: ['--bin', main.name] };
  }
  return null;
}

async function workspace(cargo, root, env) {
  const r = await execute(cargo, ['metadata', '--offline', '--format-version=1', '--no-deps'], { cwd: root, env, log: noop });
  if (r.status !== 0) refuse(`cargo metadata failed: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  return JSON.parse(r.stdout).packages.map((p) => {
    const dir = toPosix(relative(root, dirname(p.manifest_path)));
    return { name: p.name, dir: dir === '' ? '' : dir, manifest: p.manifest_path,
      targets: p.targets.map((t) => ({ name: t.name, kind: t.kind, src: toPosix(relative(root, t.src_path)) })) };
  });
}

// Rust binary operator precedence levels (higher binds tighter).
const LEVEL = new Map([['*', 9], ['/', 9], ['%', 9], ['+', 8], ['-', 8], ['<<', 7], ['>>', 7], ['&', 6], ['^', 5], ['|', 4],
  ['==', 3], ['!=', 3], ['<', 3], ['>', 3], ['<=', 3], ['>=', 3], ['&&', 2], ['||', 1]]);

/**
 * Whether a fault can be switched without changing what it means. Replacing an operator in the source
 * text lets Rust regroup the expression when the new operator binds differently (`a && b && c` with the
 * second `&&` made `||` reads `(a && b) || c`... `a && b || c && d`), which a switch around the original
 * operands cannot reproduce. Such faults get a build of their own, which is always exact.
 */
export function switchable(text, mutant) {
  // Deleting `-` before a literal: `-128i8` as `-(128i8)` overflows; such faults get their own build.
  if (mutant.genre === 'UnaryOperator') return !/^\s*[0-9]/.test(text.slice(offsetOf(text, mutant.span.end)));
  if (mutant.genre !== 'BinaryOperator') return true;
  const original = text.slice(offsetOf(text, mutant.span.start), offsetOf(text, mutant.span.end)).trim();
  const replacement = mutant.replacement.trim();
  const compound = /^(?:[-+*/%^&|]|<<|>>)=$/; // compound assignment: a whole statement, nothing to regroup
  if (compound.test(original)) return compound.test(replacement);
  const from = LEVEL.get(original);
  return from !== undefined && from === LEVEL.get(replacement);
}

function offsetOf(text, { line, column }) {
  let at = 0;
  for (let n = 1; n < line; n++) { const nl = text.indexOf('\n', at); if (nl < 0) return -1; at = nl + 1; }
  let col = 1;
  while (col < column) { const cp = text.codePointAt(at); if (cp === undefined || cp === 10) return -1; at += cp > 0xffff ? 2 : 1; col++; }
  return at;
}

/**
 * Writes a file of the scratch copy, never through a symbolic link that leads out of it: a linked file
 * becomes a real file of the copy; a folder link that leaves the copy is refused, since writing there
 * would change the assessed project.
 */
export function scratchWrite(scratch, path, text, { append = false } = {}) {
  const inside = (p) => { const real = realpathSync(scratch); return p === real || p.startsWith(`${real}${sep}`); };
  let dir;
  try { dir = realpathSync(dirname(path)); } catch { refuse(`cannot reach ${path} in the scratch copy`); }
  if (!inside(dir)) refuse(`${relative(scratch, path)} is reached through a symbolic link that leaves the scratch copy; Cupel will not write there`);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    const current = readFileSync(path, 'utf8');
    unlinkSync(path);
    writeFileSync(path, append ? current + text : text);
    return;
  }
  if (append) appendFileSync(path, text); else writeFileSync(path, text);
}

/** Applies one cargo-mutants replacement at its span (1-based lines, columns in Unicode scalar values, end exclusive). */
export function applyMutant(text, mutant) {
  const offset = ({ line, column }) => {
    let at = 0;
    for (let n = 1; n < line; n++) { const nl = text.indexOf('\n', at); if (nl < 0) return -1; at = nl + 1; }
    let col = 1;
    while (col < column) { const cp = text.codePointAt(at); if (cp === undefined || cp === 10) return -1; at += cp > 0xffff ? 2 : 1; col++; }
    return at;
  };
  const a = offset(mutant.span.start); const b = offset(mutant.span.end);
  if (a < 0 || b < a) refuse(`cannot place ${mutant.name} in its source`);
  return text.slice(0, a) + mutant.replacement + text.slice(b);
}

class Runner {
  constructor({ root, src, input, env, cargo, packages, log, targeted }) {
    Object.assign(this, { root, src, input, env, cargo, packages, log });
    this.passed = input.tests.filter((t) => t.status === 'passed');
    this.byFile = new Map();
    for (const t of this.passed) { if (!this.byFile.has(t.file)) this.byFile.set(t.file, []); this.byFile.get(t.file).push(t); }
    this.targetedUnits = new Set(targeted);
    this.targets = new Map(); // test file -> target
    this.baseline = new Map(); // target key -> { ms, failing: Set(name) }
    this.compiled = new Map();
    this.exes = new Map(); // target key -> test executable of the latest build
    this.stopAfter = STOP_AFTER_TARGETS;
    this.cargoCalls = 0; this.cargoMs = 0; this.runMs = 0; // every cargo invocation of builds and runs, for the timing line
  }

  target(file) {
    if (!this.targets.has(file)) {
      const t = targetOf(file, this.packages);
      if (!t) refuse(`cannot tell which cargo target runs the tests in ${file}`);
      this.targets.set(file, { ...t, key: `${t.pkg}\0${t.kind}\0${t.name}` });
    }
    return this.targets.get(file);
  }

  /** The passed tests whose coverage holds a line, and every passed test of a file whose setup/whole-file coverage holds it. */
  covering(source, line) {
    const cov = this.input.coverage ?? {};
    const tests = new Set();
    for (const t of this.passed) if (expand(cov.byTest?.[t.id]?.[source]).includes(line)) tests.add(t);
    for (const index of [cov.setup, cov.byFile]) for (const [file, row] of Object.entries(index ?? {})) {
      if (expand(row?.[source]).includes(line)) for (const t of this.byFile.get(file) ?? []) tests.add(t);
    }
    return [...tests];
  }

  /** A target's duration by the input: the sum of the median durations of its passed tests. */
  inputMs(key) {
    if (!this.durations) {
      this.durations = new Map();
      const median = (d) => { const v = [...(d ?? [])].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
      for (const t of this.passed) {
        const target = targetOf(t.file, this.packages);
        if (!target) continue;
        const k = `${target.pkg}\0${target.kind}\0${target.name}`;
        this.durations.set(k, (this.durations.get(k) ?? 0) + median(t.durationsMs));
      }
    }
    return this.durations.get(key) ?? 0;
  }

  /** The covering tests of a fault: those that run any of its covered, wanted lines. */
  coveringCandidate(c) {
    const seen = new Map();
    for (const line of new Set([c.line, ...(c.diffLines ?? [])])) for (const t of this.covering(c.source, line)) seen.set(t.id, t);
    return [...seen.values()];
  }

  buildFlags(targets, owners = []) {
    const flags = [];
    const seen = new Set();
    for (const t of targets) { if (seen.has(t.key)) continue; seen.add(t.key); flags.push('-p', t.pkg, ...t.flags); }
    // The faulty file's own package programs are rebuilt too, so a test that starts one runs the fault.
    for (const pkg of owners) {
      const p = this.packages.find((x) => x.name === pkg);
      if (p?.targets.some((t) => t.kind.includes('bin'))) flags.push('-p', pkg, '--bins');
    }
    return flags;
  }

  async build(targets, owners) {
    const args = ['test', '--no-run', '--verbose', '--message-format=json', ...this.buildFlags(targets, owners)];
    const r = await run(this.cargo, args, { cwd: this.src, env: this.env });
    this.cargoCalls++; this.cargoMs += r.ms;
    const errors = [];
    this.exes = new Map();
    for (const line of r.stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.reason === 'compiler-artifact' && msg.profile?.test && msg.executable) {
        const pkg = this.packages.find((p) => p.manifest === msg.manifest_path);
        const kind = msg.target?.kind ?? [];
        const k = kind.includes('test') ? 'test' : kind.includes('bin') ? 'bin' : 'lib';
        if (pkg) this.exes.set(`${pkg.name}\0${k}\0${msg.target.name}`, msg.executable);
      }
      if (msg.reason === 'compiler-message' && msg.message?.level === 'error') {
        for (const s of msg.message.spans ?? []) if (s.is_primary) errors.push({ file: toPosix(s.file_name), line: s.line_start });
      }
    }
    const log = `*** cargo ${args.join(' ')}\n${r.text.split('\n').filter((l) => !l.startsWith('{')).join('\n')}\n`;
    for (const [binary, info] of parseLog(log).compiled) this.compiled.set(binary, info);
    return { ok: r.code === 0, errors, log, ms: r.ms };
  }

  /** The SHA-256 of each wanted target's test executable from the latest build (a target without one is left out). */
  hashes(keys) {
    const out = new Map();
    for (const key of keys) { try { if (this.exes.has(key)) out.set(key, hashFile(this.exes.get(key))); } catch { /* not built */ } }
    return out;
  }

  /** One run of a target with the named tests; fault 0 means none. */
  async runTarget(target, names, fault, timeoutMs) {
    const args = ['test', '--verbose', '--no-fail-fast', '-p', target.pkg, ...target.flags, '--', '--exact', ...names];
    const env = { ...this.env };
    if (fault) env.CUPEL_FAULT = String(fault); else delete env.CUPEL_FAULT;
    const r = await run(this.cargo, args, { cwd: this.src, env, timeoutMs });
    this.cargoCalls++; this.cargoMs += r.ms; this.runMs += r.ms;
    const text = `*** cargo ${args.join(' ')}\n${r.text}\n`;
    return { ...r, log: text, parsed: parseLog(text, { reported: true }) };
  }

  /** The unmutated run of every target: time (for the time limit) and the tests that fail without any fault. */
  async measure(targetNames, fault = 0, known = null) {
    const out = new Map();
    for (const [key, { target, names }] of targetNames) {
      if (known?.has(key)) { // a stored result for this very executable and these tests
        const { ms, failing } = known.get(key);
        if (failing.size && !fault) this.log(`mutate-rust: ${target.name}: ${[...failing].join(', ')} fail(s) unmutated here although the input says passed; those failures are not catches`);
        out.set(key, { ms, failing: new Set(failing) });
        continue;
      }
      const r = await this.runTarget(target, [...names].sort(cmp), fault, 30 * 60_000);
      if (r.timedOut) refuse(`the unmutated tests of ${target.name} did not finish in 30 minutes`);
      const failing = new Set(r.parsed.runs.flatMap((x) => x.failed.map((f) => f.name)));
      if (failing.size && !fault) this.log(`mutate-rust: ${target.name}: ${[...failing].join(', ')} fail(s) unmutated here although the input says passed; those failures are not catches`);
      if (r.code !== 0 && !failing.size) refuse(`the unmutated tests of ${target.name} did not run (exit ${r.code}): ${r.text.trim().split('\n').slice(-3).join(' | ')}`);
      const { missing } = missingResults(r.parsed, names);
      if (missing.length) refuse(`the unmutated run of ${target.name} reported no result for ${missing.length} of ${names.size} named test(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}; Cupel's test id to libtest name mapping does not fit this project`);
      out.set(key, { ms: r.ms, failing });
    }
    return out;
  }

  /**
   * Tests one fault: its covering targets in order, stopping after two that caught it unless a
   * targeted unit covers it. Returns { summary, log } for attributeOutcomes, or null when unviable.
   */
  async evaluate(candidate, fault, { only = null, state = null } = {}) {
    const tests = this.coveringCandidate(candidate);
    const byTarget = new Map();
    for (const t of tests) {
      const target = this.target(t.file);
      if (!byTarget.has(target.key)) byTarget.set(target.key, { target, names: new Set() });
      byTarget.get(target.key).names.add(libtestName(t));
    }
    const ms = (key) => this.baseline.get(key)?.ms ?? 0;
    // Only inputs decide the order (as in the JavaScript runner), so the same faults stop on the same targets
    // on every run and machine: most covering tests first, then the input's durations, then the name.
    const order = [...byTarget.keys()].sort((a, b) => (byTarget.get(b).names.size - byTarget.get(a).names.size) || (this.inputMs(a) - this.inputMs(b)) || cmp(a, b));
    const full = tests.some((t) => this.targetedUnits.has(t.unit ?? t.id));
    const st = state ?? { catching: 0, timedOut: false, runs: [], done: new Set(), testMs: 0 };
    if (process.env.CUPEL_DEBUG_RUST) this.log(`debug: fault ${fault} line ${candidate.line} order ${order.map((k) => k.replaceAll('\0', '/')).join(', ')} only ${only ? [...only].map((k) => k.replaceAll('\0', '/')).join(', ') : '-'} done ${[...st.done].length} catching ${st.catching}`);
    const run0 = this.runMs;
    for (const key of order) {
      if (!full && st.catching >= this.stopAfter) break;
      if (st.done.has(key) || (only && !only.has(key))) continue;
      const { target, names } = byTarget.get(key);
      const limit = Math.max(TIMEOUT_FACTOR * ms(key), TIMEOUT_FLOOR_MS);
      let r = await this.runTarget(target, [...names].sort(cmp), fault, limit);
      // A timeout may be the machine: one more try with three times the limit.
      if (r.timedOut) r = await this.runTarget(target, [...names].sort(cmp), fault, TIMEOUT_FACTOR * limit);
      const failing = this.baseline.get(key)?.failing ?? new Set();
      // Neither timed out nor caught, yet some named test reported nothing: not a pass. Try once more.
      const incomplete = (x) => !x.timedOut && (x.code === 0 || x.parsed.runs.length) && !x.parsed.runs.some((y) => y.failed.some((f) => !failing.has(f.name)) || y.died) && missingResults(x.parsed, names).missing.length > 0;
      if (incomplete(r)) {
        this.retries = (this.retries ?? 0) + 1;
        r = await this.runTarget(target, [...names].sort(cmp), fault, limit);
        if (incomplete(r)) {
          const { missing } = missingResults(r.parsed, names);
          refuse(`${target.name} reported no result for ${missing.length} of ${names.size} named test(s) with fault ${fault || 'built in'} at line ${candidate.line} (${missing.slice(0, 3).join(', ')}); not counted as survived`);
        }
      }
      for (const x of r.parsed.runs) x.failed = x.failed.filter((f) => !failing.has(f.name));
      // Cargo failing before any test binary ran is not a catch: it is the environment.
      if (!r.timedOut && r.code !== 0 && !r.parsed.runs.length) refuse(`cargo test failed before running ${target.name}: ${r.text.trim().split('\n').slice(-3).join(' | ')}`);
      const caught = r.parsed.runs.some((x) => x.failed.length || x.died);
      if (process.env.CUPEL_DEBUG_RUST) this.log(`debug: fault ${fault} ${candidate.line} ${target.name} ${Math.round(r.ms)}ms code ${r.code} caught ${caught} runs ${r.parsed.runs.length} failed ${r.parsed.runs.map((x) => x.failed.map((f) => f.name).join('+')).join('|')}`);
      if (r.timedOut) st.timedOut = true;
      if (caught || r.timedOut) st.catching++;
      st.runs.push(...r.parsed.runs);
      st.done.add(key);
    }
    st.testMs += this.runMs - run0;
    // Targets still owed: stopped early with fewer than two catches (or a full run is needed), and some were skipped.
    st.pending = (full || st.catching < this.stopAfter) ? order.filter((key) => !st.done.has(key)) : [];
    return st;
  }

  /** The outcome of a finished evaluation, for attributeOutcomes. */
  static outcome(st) {
    const caught = st.runs.some((x) => x.failed.length || x.died);
    const log = { compiled: new Map(), runs: st.runs, doctestFailures: 0, nextest: false };
    return { summary: caught ? 'CaughtMutant' : st.timedOut ? 'Timeout' : 'MissedMutant', log };
  }
}

function rustflags(env) {
  const out = { ...env };
  if (out.CARGO_ENCODED_RUSTFLAGS !== undefined) out.CARGO_ENCODED_RUSTFLAGS = [out.CARGO_ENCODED_RUSTFLAGS, '--cap-lints=allow'].filter(Boolean).join('\x1f');
  else out.RUSTFLAGS = [out.RUSTFLAGS, '--cap-lints=allow'].filter(Boolean).join(' ');
  return out;
}

/**
 * mutateCargoFast({ root, input, config, scope, log }) → Cupel mutation object, with the same
 * plan (scope, no-coverage, cap, reuse) and the same rows as mutateCargo.
 */
export async function mutateCargoFast({ root, input, config = {}, scope = {}, log = noop, environment = process.env } = {}) {
  const started = performance.now();
  const cfg = effectiveConfig(config, SCHEMA);
  const settings = config.runners?.cargo?.mutants ?? {};
  const wanted = wantedLines(input, cfg, scope);
  if (!wanted.size) return { mutants: [], targeted: [], sampled: false };
  const tool = findTool(settings.command ?? 'cargo-mutants', environment);
  if (!tool) refuse(`cargo-mutants was not found (Cupel uses its fault listing): ${INSTALL}`);
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const scratch = mkdtempSync(join(root, '.scratch', 'cupel-rust-'));
  let session = null;
  try {
    const base = environmentFor(root, scratch, environment, tool);
    const listed = await execute(tool, ['mutants', '--list', '--json', '--colors=never', ...(settings.args ?? [])], { cwd: root, env: base, log: noop });
    if (listed.status !== 0) refuse(`cargo mutants --list failed (exit ${listed.status}): ${listed.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    const listing = JSON.parse(listed.stdout);
    let plan = planCargoMutants({ input, cfg, wanted, listing, scope });
    // A fault's own build costs about this much without switches; with them, one build serves all.
    if (scope.plan) return { plan: planEntries({ plan, input, scope, perFaultMs: settings.schemata === false ? 20_000 : 2_000 }), sampled: plan.sampled, seed: plan.seed };
    if (scope.only) plan = slicePlan(plan, scope.only);
    if (plan.noCoverage.length) log(`mutate-rust: ${plan.noCoverage.length} fault(s) on lines no passed test runs are no-coverage, not built`);
    if (plan.sampled) log(`mutate-rust: sampled ${plan.chosen.length} of ${plan.candidates.length} faults on covered lines (seed ${plan.seed})`);
    if (plan.reused.length) log(`mutate-rust: ${plan.reused.length} result(s) reused from an earlier run`);
    const ran = new Set([...plan.noCoverage.map((m) => m.id), ...plan.reused.map((m) => m.id), ...(plan.elsewhere ?? [])]);
    const outcomes = [];
    const timings = new Map();
    const phases = { firstBuildMs: 0, baselineMs: 0, switchedBuildMs: 0, switchesOffMs: 0, restoreBuildMs: 0 };
    const sessionStats = { baselines: [0, 0], off: [0, 0] };
    const faultTimes = new Map(); // fault id -> { buildMs, testMs }
    const addFault = (id, build, test) => { const f = faultTimes.get(id) ?? { buildMs: 0, testMs: 0 }; f.buildMs += build; f.testMs += test; faultTimes.set(id, f); };
    const clock = async (key, work) => { const t = performance.now(); try { return await work(); } finally { phases[key] += performance.now() - t; } };
    const partial = new Map(); // fault id -> evaluation still owing timing-sensitive targets
    const byName = new Map(listing.map((m) => [m.name, m]));
    let runner = null;
    let work = scratch; // where files may be written: the session or the throwaway scratch
    if (plan.run.length) {
      const cargo = base.CARGO ?? findTool('cargo', base);
      if (!cargo) refuse('cargo is not on PATH');
      let src; let env; let cargoTool = cargo;
      if (settings.session === false) {
        src = copyProject(root, join(scratch, 'project'));
        env = rustflags({ ...base, CARGO_TARGET_DIR: join(scratch, 'target') });
      } else {
        const flags = rustflags(base);
        const rustc = findTool('rustc', base);
        const probe = async (tool, args) => { try { const r = tool ? await execute(tool, args, { cwd: root, env: base, log: noop }) : null; return r?.status === 0 ? r.stdout : ''; } catch { return ''; } };
        const rustcV = await probe(rustc, ['-vV']);
        const id = sessionId({
          root, rustc: rustcV, cargo: await probe(cargo, ['--version']), host: `${process.platform}-${process.arch} ${/^host: (.*)$/m.exec(rustcV)?.[1] ?? ''}`,
          rustflags: flags.RUSTFLAGS ?? '', encodedRustflags: flags.CARGO_ENCODED_RUSTFLAGS ?? '', runner: config.runners?.cargo ?? {}, version: cupelVersion(),
        });
        session = await openSession({ root, id });
        work = session.dir;
        src = session.project;
        env = rustflags({ ...base, CARGO_TARGET_DIR: session.target });
        if (base.CARGO && base.CARGO.startsWith(scratch)) { // the Rosetta shim lives with the session, so its path never changes
          cargoTool = join(session.dir, 'native-cargo');
          copyFileSync(base.CARGO, cargoTool); chmodSync(cargoTool, 0o755);
          env.CARGO = cargoTool;
        }
      }
      delete env.CUPEL_FAULT;
      const packages = await workspace(cargoTool, src, env);
      runner = new Runner({ root, src, input, env, cargo: cargoTool, packages, log, targeted: scope.targeted ?? [] });
      if (scope.firstCatch) runner.stopAfter = 1;

      // Targets and test names every fault needs, for the baseline build and runs.
      const needed = new Map();
      for (const c of plan.run) for (const t of runner.coveringCandidate(c)) {
        const target = runner.target(t.file);
        if (!needed.has(target.key)) needed.set(target.key, { target, names: new Set() });
        needed.get(target.key).names.add(libtestName(t));
      }
      const owners = [...new Set(plan.run.map((c) => byName.get(c.name)?.package).filter(Boolean))];
      const targets = [...needed.values()].map((x) => x.target);
      log(`mutate-rust: ${plan.run.length} fault(s); building ${targets.length} test target(s) of ${new Set(targets.map((t) => t.pkg)).size} package(s) once`);
      const first = await clock('firstBuildMs', () => runner.build(targets, owners));
      if (!first.ok) refuse(`the unmutated test targets do not build: ${first.log.trim().split('\n').slice(-3).join(' | ')}`);
      // The unmutated pass of a target is reused when the session saw this very executable with these very tests.
      const sameNames = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
      const nameList = (names) => [...names].sort(cmp);
      const stored = (table, key, names, hash) => {
        const rec = session?.meta[table]?.[key];
        if (!rec || !hash || !(rec.hashes ?? [rec.hash]).includes(hash) || !sameNames(rec.names ?? [], nameList(names))) return null;
        return { ms: rec.ms, failing: new Set(rec.failing) };
      };
      const firstHashes = session ? runner.hashes(needed.keys()) : new Map();
      const known = new Map();
      for (const [key, { names }] of needed) { const rec = stored('baselines', key, names, firstHashes.get(key)); if (rec) known.set(key, rec); }
      sessionStats.baselines = [known.size, needed.size];
      runner.baseline = await clock('baselineMs', () => runner.measure(needed, 0, known));
      if (session) {
        for (const [key, { names }] of needed) {
          const { ms, failing } = runner.baseline.get(key);
          const hash = firstHashes.get(key);
          if (hash) session.meta.baselines[key] = { hashes: [hash], names: nameList(names), ms, failing: [...failing].sort(cmp) };
          else delete session.meta.baselines[key];
        }
        session.save();
      }

      // C: switchable faults in one build, when the rewriter is certain and the tests agree.
      const single = new Set(plan.run.map((c) => c.id));
      const switched = new Map(); // number -> candidate
      if (settings.schemata !== false) {
        let schemata = null;
        try { schemata = await import('./schemata.mjs'); } catch { schemata = null; }
        if (schemata) {
          const numbers = new Map(plan.run.map((c, k) => [c.id, k + 1]));
          const byFile = new Map();
          for (const c of plan.run) { if (!byFile.has(c.source)) byFile.set(c.source, []); byFile.get(c.source).push(c); }
          const originals = new Map();
          let files = [...byFile.keys()].sort(cmp);
          const render = (file, excluded) => {
            const text = originals.get(file) ?? readFileSync(join(src, file), 'utf8');
            originals.set(file, text);
            const faults = byFile.get(file).filter((c) => !excluded.has(c.id) && switchable(text, byName.get(c.name)))
              .map((c) => ({ number: numbers.get(c.id), ...byName.get(c.name) }));
            const r = schemata.switchFaults(text, faults);
            scratchWrite(work, join(src, file), r.text);
            return r;
          };
          // The switch module goes at the end of every library and program root of the package; a root
          // re-rendered from its original text in a later round gets it again.
          const inject = (pkgName) => {
            const p = packages.find((x) => x.name === pkgName);
            for (const t of p?.targets ?? []) {
              if (!t.kind.some((k) => ['lib', 'rlib', 'bin'].includes(k))) continue;
              const path = join(src, t.src);
              const text = readFileSync(path, 'utf8');
              if (/#!\[\s*no_std\s*\]/.test(text)) return false;
              if (!originals.has(t.src)) originals.set(t.src, text);
              if (!text.includes('pub mod __cupel_faults')) scratchWrite(work, path, `${text.endsWith('\n') ? '' : '\n'}${schemata.faultModule()}\n`, { append: true });
            }
            return true;
          };
          const excluded = new Set();
          var sensitive = new Set();
          const restore = () => { for (const [file, text] of originals) scratchWrite(work, join(src, file), text); };
          let ok = false;
          const failedBefore = new Set();
          for (let round = 0; round < 8 && files.length; round++) {
            const current = new Map();
            for (const file of files) {
              const r = render(file, excluded);
              for (const n of r.switched) current.set(n, plan.run[n - 1]);
            }
            const pkgs = new Set([...current.values()].map((c) => byName.get(c.name)?.package));
            let noStd = false;
            for (const pkg of pkgs) if (!inject(pkg)) noStd = true;
            if (noStd) { log('mutate-rust: a no_std crate cannot read CUPEL_FAULT; faults run one build each'); break; }
            if (!current.size) break;
            const built = await clock('switchedBuildMs', () => runner.build(targets, owners));
            if (built.ok) { for (const [n, c] of current) switched.set(n, c); ok = true; break; }
            // First drop only the faults near each error and try again; a file that fails a second
            // time has all its faults run one build each.
            const bad = new Set(built.errors.map((e) => e.file));
            const failing = files.filter((f) => bad.has(f));
            if (!failing.length) { log('mutate-rust: the switched build failed outside the faulty files; faults run one build each'); break; }
            for (const f of failing) {
              const near = byFile.get(f).filter((c) => !excluded.has(c.id) && built.errors.some((e) => e.file === f && Math.abs(e.line - c.line) <= 5));
              if (failedBefore.has(f) || !near.length) {
                for (const c of byFile.get(f)) excluded.add(c.id);
                files = files.filter((x) => x !== f);
                scratchWrite(work, join(src, f), originals.get(f));
              } else {
                for (const c of near) excluded.add(c.id);
                failedBefore.add(f);
              }
            }
          }
          if (ok) {
            // Every switch off must mean the original: the covering tests behave exactly as unmodified.
            const offHashes = session ? runner.hashes(needed.keys()) : new Map();
            const offKnown = new Map();
            for (const [key, { names }] of needed) { const rec = stored('switched', key, names, offHashes.get(key)); if (rec) offKnown.set(key, rec); }
            sessionStats.off = [offKnown.size, needed.size];
            const off = await clock('switchesOffMs', () => runner.measure(needed, 0, offKnown));
            if (session) {
              session.meta.switched = {};
              for (const [key, { names }] of needed) {
                const hash = offHashes.get(key);
                if (hash) session.meta.switched[key] = { hashes: [hash], names: nameList(names), ms: off.get(key).ms, failing: [...off.get(key).failing].sort(cmp) };
              }
              session.save();
            }
            for (const key of needed.keys()) {
              const a = runner.baseline.get(key).failing; const b = off.get(key).failing;
              if (a.size !== b.size || ![...a].every((n) => b.has(n))) sensitive.add(key);
            }
            if (sensitive.size) log(`mutate-rust: with every switch off, ${[...sensitive].map((k) => needed.get(k).target.name).join(', ')} behaved differently (timing-sensitive tests, for example); they run on one-build-per-fault only`);
            if (sensitive.size === needed.size) switched.clear();
          }
          if (!switched.size) { restore(); await clock('switchedBuildMs', () => runner.build(targets, owners)); }
          else {
            log(`mutate-rust: ${switched.size} of ${plan.run.length} fault(s) switched in one build`);
            const safe = new Set([...needed.keys()].filter((k) => !sensitive.has(k)));
            for (const [n, c] of [...switched].sort((a, b) => a[0] - b[0])) {
              const t0 = performance.now();
              const st = await runner.evaluate(c, n, { only: safe });
              timings.set(c.id, Math.round(performance.now() - t0));
              addFault(c.id, 0, st.testMs);
              // Answered without the sensitive targets, or still owed some on a build of its own.
              if (st.pending.length) partial.set(c.id, st);
              else { outcomes.push({ mutant: byName.get(c.name), ...Runner.outcome(st) }); ran.add(c.id); }
              single.delete(c.id);
            }
            if (partial.size) log(`mutate-rust: ${switched.size - partial.size} fault(s) settled with the switched build; ${partial.size} still need timing-sensitive targets on their own build`);
            restore();
            const rebuilt = await clock('switchedBuildMs', () => runner.build(targets, owners));
            if (!rebuilt.ok) refuse('the unmutated test targets no longer build after removing the switches');
          }
        }
      }

      // A+B: every other fault gets its own incremental build in the scratch copy; faults the switched
      // build answered in part continue with the targets they still owe.
      const rest = plan.run.filter((c) => single.has(c.id) || partial.has(c.id));
      if (rest.length) log(`mutate-rust: ${rest.length} fault(s) with one build each${partial.size ? ` (${partial.size} only for their remaining targets)` : ''}`);
      for (const c of rest) {
        const mutant = byName.get(c.name);
        const path = join(src, c.source);
        const original = readFileSync(path, 'utf8');
        const t0 = performance.now();
        try {
          scratchWrite(work, path, applyMutant(original, mutant));
          const before = partial.get(c.id);
          const own = runner.coveringCandidate(c).map((t) => runner.target(t.file)).filter((t) => !before || before.pending.includes(t.key));
          const built = await runner.build(own, [mutant.package].filter(Boolean));
          addFault(c.id, built.ms, 0);
          if (!built.ok) {
            // A fault the switched build compiled must compile on its own; anything else is the environment.
            if (before) refuse(`${mutant.name} compiled switched but not on its own`);
            outcomes.push({ mutant, summary: 'Unviable', log: null }); ran.add(c.id); continue;
          }
          const t1 = before?.testMs ?? 0;
          const st = await runner.evaluate(c, 0, before ? { only: new Set(before.pending), state: before } : {});
          addFault(c.id, 0, st.testMs - t1);
          outcomes.push({ mutant, ...Runner.outcome(st) });
          ran.add(c.id);
        } finally { scratchWrite(work, path, original); timings.set(c.id, (timings.get(c.id) ?? 0) + Math.round(performance.now() - t0)); }
      }
      if (session) {
        // The session's target must end on the unmodified project: a build of the last fault would be reused as it is.
        if (rest.length) await clock('restoreBuildMs', () => runner.build(targets, owners));
        const final = runner.hashes(needed.keys());
        for (const [key, rec] of Object.entries(session.meta.baselines)) { // the unmodified build that ends this run is also the baseline's executable
          const hash = final.get(key);
          if (hash && !rec.hashes.includes(hash)) rec.hashes.push(hash);
        }
        session.save();
      }
    }
    let rows = outcomes.length ? attributeOutcomes({ root, input, listing, compiled: runner?.compiled ?? new Map(), outcomes }).mutation.mutants : [];
    if (scope.timings) rows = rows.map((r) => (timings.has(r.id) ? { ...r, durationMs: timings.get(r.id) } : r));
    const unviable = outcomes.filter((o) => o.summary === 'Unviable').length;
    if (outcomes.length) log(`mutate-rust: ${rows.length} fault(s) tested; ${unviable} did not compile`);
    if (runner) {
      const sec = (ms) => Math.round(ms) / 1000;
      const faults = [...faultTimes.values()];
      const sum = (key) => faults.reduce((a, f) => a + f[key], 0);
      const report = {
        totalMs: Math.round(performance.now() - started),
        firstBuildMs: Math.round(phases.firstBuildMs), baselineMs: Math.round(phases.baselineMs),
        switchedBuildMs: Math.round(phases.switchedBuildMs), switchesOffMs: Math.round(phases.switchesOffMs), restoreBuildMs: Math.round(phases.restoreBuildMs),
        session: session ? (session.warm ? 'warm' : 'cold') : 'off', baselinesReused: sessionStats.baselines[0], baselinesTotal: sessionStats.baselines[1],
        switchesOffReused: sessionStats.off[0], switchesOffTotal: sessionStats.off[1],
        faults: faults.length, faultBuildMs: Math.round(sum('buildMs')), faultTestMs: Math.round(sum('testMs')),
        cargoCalls: runner.cargoCalls, cargoMs: Math.round(runner.cargoMs), retries: runner.retries ?? 0,
        perFault: Object.fromEntries([...faultTimes].sort((a, b) => cmp(a[0], b[0])).map(([id, f]) => [id, { buildMs: Math.round(f.buildMs), testMs: Math.round(f.testMs) }])),
      };
      const sessionText = session ? `, session ${session.warm ? 'warm' : 'cold'}, baselines reused ${sessionStats.baselines[0]}/${sessionStats.baselines[1]}${sessionStats.off[1] ? `, switches-off reused ${sessionStats.off[0]}/${sessionStats.off[1]}` : ''}` : '';
      log(`mutate-rust: timings first-build ${sec(report.firstBuildMs)}s, baseline ${sec(report.baselineMs)}s, switched-build ${sec(report.switchedBuildMs)}s, switches-off ${sec(report.switchesOffMs)}s, faults ${faults.length} (build ${sec(report.faultBuildMs)}s, test ${sec(report.faultTestMs)}s), cargo ${report.cargoCalls} call(s) ${sec(report.cargoMs)}s, total ${sec(report.totalMs)}s${sessionText}`);
      if (environment.CUPEL_RUST_TIMINGS) { try { writeFileSync(environment.CUPEL_RUST_TIMINGS, `${JSON.stringify(report, null, 2)}\n`); } catch { /* developer aid only */ } }
    }
    const mutants = [...plan.noCoverage, ...plan.reused, ...rows].sort((a, b) => cmp(a.id, b.id));
    for (let i = 1; i < mutants.length; i++) if (mutants[i].id === mutants[i - 1].id) refuse(`duplicate mutant id ${mutants[i].id}`);
    const targeted = targetedUnits({ input, listing, ran, rows: mutants });
    return { mutants, targeted, sampled: plan.sampled, ...(plan.sampled ? { seed: plan.seed } : {}) };
  } finally {
    if (session) {
      try { enforceCap(root, { capBytes: (settings.sessionCapGB ?? DEFAULT_CAP_GB) * 1024 ** 3, keep: basename(session.dir) }); } catch { /* the cap is housekeeping */ }
      session.release();
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

export { baseRow, mutantId };
