// Rust mutation through the user's installed cargo-mutants (D19). Cupel never
// downloads it. cargo-mutants copies the project to its own scratch tree, so
// the project is never changed; its output goes to Cupel's scratch directory.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { effectiveConfig } from '../engine/config.mjs';
import { isCriticalSource } from '../engine/model.mjs';
import { anyGlobMatches } from '../engine/match.mjs';
import { parse } from '../engine/lines.mjs';
import { mutationModel } from '../mutate/model.mjs';
import { cmp } from '../engine/order.mjs';
import { CargoMutantsError, importCargoMutants } from './import.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url), 'utf8'));
const noop = () => {};
const refuse = (message) => { throw new CargoMutantsError(message); };
const INSTALL = 'install cargo-mutants (for example `cargo install --locked cargo-mutants`) or set runners.cargo.mutants.command';

const lines = (ranges) => ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

/** The coverable lines to mutate, per source, for a Cupel scope (critical, changed, targeted). */
export function wantedLines(input, cfg, scope = {}) {
  if (scope.functions) refuse('Rust function-scope mutation is not implemented');
  const model = mutationModel(input, cfg, scope.targeted ?? []);
  const wanted = new Map();
  const add = (source, ranges) => {
    if (!model.sources.has(source)) return;
    const coverable = new Set(lines(model.sources.get(source).coverable));
    const target = wanted.get(source) ?? new Set();
    for (const line of lines(ranges)) if (coverable.has(line)) target.add(line);
    wanted.set(source, target);
  };
  if (scope.critical) for (const [source, row] of model.sources) if (isCriticalSource(source, cfg)) add(source, row.coverable);
  for (const [source, value] of Object.entries(scope.changed ?? {})) {
    if (!model.sources.has(source)) refuse(`changed Rust source is absent from the input: ${source}`);
    const ranges = Array.isArray(value) ? value.map((n) => [n, n]) : parse(value).set;
    add(source, ranges);
  }
  for (const uid of scope.targeted ?? []) {
    const unit = model.unitById.get(uid);
    if (!unit) refuse(`targeted Rust unit is absent from the input: ${uid}`);
    for (const [source, ranges] of unit.own) add(source, ranges);
  }
  const include = cfg.scope?.include ?? ['**'];
  const exclude = cfg.scope?.exclude ?? [];
  for (const [source, set] of [...wanted]) if (!set.size || !anyGlobMatches(include, source) || anyGlobMatches(exclude, source)) wanted.delete(source);
  return wanted;
}

/**
 * A unified diff whose added lines are exactly the wanted lines, with their
 * current text, for `cargo mutants --in-diff`. Each run of lines is shown as
 * replaced by itself, so the new side matches the tree.
 */
export function scopeDiff(root, wanted) {
  const out = [];
  for (const [source, set] of [...wanted].sort(([a], [b]) => cmp(a, b))) {
    const text = readFileSync(join(root, source), 'utf8').split('\n');
    out.push(`--- a/${source}`, `+++ b/${source}`);
    const sorted = [...set].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      let j = i; while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      const [a, b] = [sorted[i], sorted[j]];
      const body = text.slice(a - 1, b);
      out.push(`@@ -${a},${body.length} +${a},${body.length} @@`, ...body.map((l) => `-${l}`), ...body.map((l) => `+${l}`));
      i = j + 1;
    }
  }
  return `${out.join('\n')}\n`;
}

function findTool(command, env) {
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : null;
  const names = process.platform === 'win32' ? [`${command}.exe`, command] : [command];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** True for a Mach-O executable without an arm64 slice (an Intel build under Rosetta). */
export function intelOnlyMachO(path) {
  const fd = openSync(path, 'r'); const head = Buffer.alloc(8);
  try { readSync(fd, head, 0, 8, 0); } finally { closeSync(fd); }
  const magic = head.readUInt32LE(0);
  if (magic === 0xfeedfacf) return head.readUInt32LE(4) === 0x01000007; // x86_64 thin binary
  return false;
}

function execute(command, args, { cwd, env, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; for (const line of String(chunk).split('\n')) if (/^(?:MISSED|caught|TIMEOUT|unviable|ok|\d+ mutants tested)/i.test(line.trim())) log(`cargo-mutants: ${line.trim()}`); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new CargoMutantsError(`${command}: ${error.message}`)));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** cargo-mutants exits 0 (all caught), 2 (some missed) or 3 (some timed out); anything else failed. */
const ACCEPTED = new Set([0, 2, 3]);

async function runCargoMutants({ tool, root, env, scratch, name, extra, log }) {
  const out = join(scratch, name);
  const args = ['mutants', '--no-shuffle', '--test-workspace=true', '--cargo-test-arg=--no-fail-fast', '--colors=never', '-o', out, ...extra];
  const result = await execute(tool, args, { cwd: root, env, log });
  if (!ACCEPTED.has(result.status)) refuse(`cargo-mutants failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().split('\n').slice(-5).join(' | ')}`);
  return join(out, 'mutants.out');
}

function environmentFor(root, scratch, base, tool) {
  const env = { ...base, CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never' };
  delete env.CARGO_TARGET_DIR; // cargo-mutants builds inside its own copy
  if (process.platform === 'darwin' && process.arch === 'arm64' && intelOnlyMachO(tool)) {
    // An Intel cargo-mutants runs under Rosetta and its children inherit Intel:
    // C build scripts would then target x86_64. Start Cargo natively.
    const cargo = findTool('cargo', env);
    if (!cargo) refuse('cargo is not on PATH');
    const shim = join(scratch, 'native-cargo');
    writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/arch -arm64 '${cargo.replaceAll("'", "'\\''")}' "$@"\n`);
    chmodSync(shim, 0o755);
    env.CARGO = shim;
  }
  return env;
}

function untargeted(targeted, input, cfg, rows) {
  if (!rows.length || !targeted.length) return targeted;
  const model = mutationModel(input, cfg, targeted);
  return targeted.filter((uid) => {
    const own = model.unitById.get(uid)?.own;
    return !rows.some((m) => own?.get(m.source)?.some(([a, b]) => m.line >= a && m.line <= b));
  });
}

function escapeRegex(text) { return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); }

/**
 * mutateCargo({ root, input, config, scope, log }) → Cupel mutation object.
 * Runs every cargo-mutants mutant on the wanted lines, re-runs timeouts once
 * alone with a longer limit, and imports the result with per-test catches.
 */
export async function mutateCargo({ root, input, config = {}, scope = {}, log = noop, environment = process.env } = {}) {
  const cfg = effectiveConfig(config, SCHEMA);
  const settings = config.runners?.cargo?.mutants ?? {};
  const wanted = wantedLines(input, cfg, scope);
  if (!wanted.size) return { mutants: [], targeted: [], sampled: false };
  const tool = findTool(settings.command ?? 'cargo-mutants', environment);
  if (!tool) refuse(`cargo-mutants was not found: ${INSTALL}`);
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const scratch = mkdtempSync(join(root, '.scratch', 'cupel-cargo-mutants-'));
  try {
    const env = environmentFor(root, scratch, environment, tool);
    const listed = await execute(tool, ['mutants', '--list', '--json', '--colors=never', ...(settings.args ?? [])], { cwd: root, env, log: noop });
    if (listed.status !== 0) refuse(`cargo mutants --list failed (exit ${listed.status}): ${listed.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    const listing = JSON.parse(listed.stdout);
    const diffPath = join(scratch, 'scope.diff');
    writeFileSync(diffPath, scopeDiff(root, wanted));
    const jobs = settings.jobs ?? 1;
    log(`mutate-cargo: cargo-mutants on ${[...wanted.values()].reduce((n, s) => n + s.size, 0)} lines in ${wanted.size} files, ${jobs} job(s)`);
    const outDir = await runCargoMutants({ tool, root, env, scratch, name: 'main', extra: ['--in-diff', diffPath, '-j', String(jobs), ...(settings.args ?? [])], log });
    let { mutation, notes } = importCargoMutants({ root, input, outDir, listing });
    // A timeout under load can be contention, not detection: re-run each once,
    // alone, with ten times the usual limit, and keep that result.
    const timedOut = JSON.parse(readFileSync(join(outDir, 'outcomes.json'), 'utf8')).outcomes
      .filter((o) => o.summary === 'Timeout' && o.scenario?.Mutant).map((o) => o.scenario.Mutant.name);
    if (timedOut.length) {
      log(`mutate-cargo: re-running ${timedOut.length} timed-out mutant(s) alone`);
      const again = await runCargoMutants({ tool, root, env, scratch, name: 'timeouts',
        extra: ['-j', '1', '--timeout-multiplier', '10', ...timedOut.flatMap((n) => ['--re', `^${escapeRegex(n)}$`]), ...(settings.args ?? [])], log });
      const rerun = importCargoMutants({ root, input, outDir: again }).mutation.mutants;
      const byId = new Map(rerun.map((m) => [m.id, m]));
      mutation = { ...mutation, mutants: mutation.mutants.map((m) => byId.get(m.id) ?? m) };
      // A fault that still times out has no killer: a unit whose own lines hold
      // it is no longer complete evidence (missing data is never "no kill").
      mutation.targeted = untargeted(mutation.targeted, input, cfg, rerun.filter((m) => m.status === 'timeout'));
    }
    log(`mutate-cargo: ${mutation.mutants.length} mutants imported; ${notes.unviable} unviable, ${notes.uncompiled} in code not built for this host, ${notes.pinnedCreditDropped} source-pin catches not credited`);
    return mutation;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** K7 confirmation: re-run the given survivors twice more; any detection replaces the row. */
export async function confirmCargo({ root, input, mutation, ids, config = {}, log = noop, environment = process.env } = {}) {
  const settings = config.runners?.cargo?.mutants ?? {};
  const byId = new Map(mutation.mutants.map((m, i) => [m.id, i]));
  const todo = [...new Set(ids)].sort(cmp).filter((id) => byId.has(id) && mutation.mutants[byId.get(id)].status === 'survived');
  const output = { ...mutation, mutants: mutation.mutants.map((m) => ({ ...m })) };
  if (!todo.length) return output;
  const tool = findTool(settings.command ?? 'cargo-mutants', environment);
  if (!tool) refuse(`cargo-mutants was not found: ${INSTALL}`);
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const scratch = mkdtempSync(join(root, '.scratch', 'cupel-cargo-confirm-'));
  try {
    const env = environmentFor(root, scratch, environment, tool);
    const names = todo.map((id) => {
      const m = mutation.mutants[byId.get(id)];
      const column = id.slice(m.source.length + 1).split(':')[1];
      return `^${escapeRegex(`${m.source}:${m.line}:${column}: ${m.description}`)}$`;
    });
    for (let rep = 0; rep < 2; rep++) {
      const outDir = await runCargoMutants({ tool, root, env, scratch, name: `confirm-${rep}`, extra: ['-j', '1', ...names.flatMap((n) => ['--re', n]), ...(settings.args ?? [])], log });
      for (const row of importCargoMutants({ root, input, outDir }).mutation.mutants) {
        if (!byId.has(row.id) || row.status === 'survived') continue;
        output.mutants[byId.get(row.id)] = row;
        log(`mutate-cargo: confirmation changed ${row.id} to ${row.status}`);
      }
    }
    return output;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** The full cargo-mutants listing (with each mutant's diff) for the project. */
export async function listMutants({ root, config = {}, environment = process.env } = {}) {
  const settings = config.runners?.cargo?.mutants ?? {};
  const tool = findTool(settings.command ?? 'cargo-mutants', environment);
  if (!tool) refuse(`cargo-mutants was not found: ${INSTALL}`);
  const env = { ...environment, CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never' };
  const listed = await execute(tool, ['mutants', '--list', '--json', '--colors=never', ...(settings.args ?? [])], { cwd: root, env, log: noop });
  if (listed.status !== 0) refuse(`cargo mutants --list failed (exit ${listed.status})`);
  return JSON.parse(listed.stdout);
}
