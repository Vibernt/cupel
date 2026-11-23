// Rust mutation through the user's installed cargo-mutants (D19). Cupel never
// downloads it. cargo-mutants copies the project to its own scratch tree, so
// the project is never changed; its output goes to Cupel's scratch directory.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { effectiveConfig } from '../engine/config.mjs';
import { isCriticalSource } from '../engine/model.mjs';
import { anyGlobMatches } from '../engine/match.mjs';
import { parse } from '../engine/lines.mjs';
import { mutationModel } from '../mutate/model.mjs';
import { cmp } from '../engine/order.mjs';
import { prng, sample } from '../mutate/operators.mjs';
import { wholeUnits } from '../mutate/index.mjs';
import { CargoMutantsError, baseRow, importCargoMutants, mutantId, targetedUnits } from './import.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url), 'utf8'));
const noop = () => {};
const refuse = (message) => { throw new CargoMutantsError(message); };
export const INSTALL = 'install cargo-mutants (for example `cargo install --locked cargo-mutants`) or set runners.cargo.mutants.command';

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

const spanLines = (m) => {
  const a = m.span.start.line;
  return Array.from({ length: Math.max(a, m.span.end?.line ?? a) - a + 1 }, (_, i) => a + i);
};

/**
 * Which test files run each line of the wanted sources: the coverage of passed
 * tests, plus the setup and whole-file coverage of test files that have passed
 * tests (the selection Session.select makes in mutate/index.mjs).
 * Map(source → Map(line → Set(test file))).
 */
export function lineRunners(input, wanted) {
  const runners = new Map();
  const add = (file, row) => {
    for (const [source, spec] of Object.entries(row ?? {})) {
      if (!wanted.has(source)) continue;
      if (!runners.has(source)) runners.set(source, new Map());
      const byLine = runners.get(source);
      for (const n of lines(parse(spec).set)) {
        if (!byLine.has(n)) byLine.set(n, new Set());
        byLine.get(n).add(file);
      }
    }
  };
  const passed = input.tests.filter((t) => t.status === 'passed');
  for (const t of passed) add(t.file, input.coverage?.byTest?.[t.id]);
  const files = new Set(passed.map((t) => t.file));
  for (const index of [input.coverage?.setup, input.coverage?.byFile]) {
    for (const [file, row] of Object.entries(index ?? {})) if (files.has(file)) add(file, row);
  }
  return runners;
}

/** A seeded shuffle, the same as seededOrder in mutate/index.mjs. */
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
 * Which listed mutants a Cupel scope gets, before anything runs:
 * { noCoverage, candidates, chosen, reused, run, sampled, seed }.
 *
 * In scope is every listed mutant that `--in-diff` would pick for the wanted
 * lines (its span touches one) and whose line the coverage input can count.
 * A mutant on lines no passed test runs is a `noCoverage` row now: no test
 * could fail on it, so running it would only cost a build. The rest are
 * `candidates`; `mutation.maxMutants` of them are `chosen` by the JS mutator's
 * rule: targeted units' own lines first, whole units when those alone exceed
 * the cap, then a seeded sample (`mutation.seed`) of the others. A chosen
 * mutant whose id is in `scope.reuse` takes that stored row (`reused`) and
 * counts toward the cap as if it ran; the others are `run`.
 */
export function planCargoMutants({ input, cfg, wanted, listing, scope = {} }) {
  const { maxMutants, seed } = cfg.mutation;
  const runners = lineRunners(input, wanted);
  const coverable = new Map([...wanted.keys()].map((source) => [source, new Set(lines(parse(input.sources[source]?.coverable ?? '').set))]));
  const noCoverage = [];
  const candidates = [];
  for (const entry of listing) {
    const row = baseRow(entry);
    const want = wanted.get(row.source);
    if (!want || !coverable.get(row.source).has(row.line)) continue;
    const touched = spanLines(entry);
    if (!touched.some((n) => want.has(n))) continue;
    const covered = touched.filter((n) => runners.get(row.source)?.has(n));
    if (!covered.length) { noCoverage.push({ ...row, status: 'no-coverage' }); continue; }
    const files = new Set(covered.flatMap((n) => [...runners.get(row.source).get(n)]));
    const diffLines = covered.filter((n) => want.has(n));
    candidates.push({ ...row, column: entry.span.start.column, name: entry.name, files, diffLines: diffLines.length ? diffLines : [row.line] });
  }
  candidates.sort((a, b) => cmp(a.source, b.source) || a.line - b.line || a.column - b.column || cmp(a.id, b.id));
  noCoverage.sort((a, b) => cmp(a.id, b.id));

  let chosen = candidates;
  if (candidates.length > maxMutants) {
    const model = mutationModel(input, cfg, scope.targeted ?? []);
    const own = new Map();
    for (const uid of scope.targeted ?? []) if (model.unitById.has(uid)) own.set(uid, model.unitById.get(uid).own);
    const onTargeted = (c) => [...own.values()].some((o) => o.get(c.source)?.some(([a, b]) => c.line >= a && c.line <= b));
    const first = candidates.filter(onTargeted);
    const rest = candidates.filter((c) => !onTargeted(c));
    const preferred = first.length >= maxMutants ? wholeUnits(first, own, maxMutants) : [...first, ...sample(rest, maxMutants - first.length, seed)];
    const picked = new Set(preferred);
    // As in the JS mutator, whole units that leave room are topped up from the
    // remaining targeted sites, then the rest, in seeded order.
    const ordered = [...preferred, ...seededOrder(first.filter((c) => !picked.has(c)), seed), ...seededOrder(rest.filter((c) => !picked.has(c)), seed)];
    const keep = new Set(ordered.slice(0, maxMutants));
    chosen = candidates.filter((c) => keep.has(c));
  }
  const reuse = scope.reuse ?? {};
  const isReused = (c) => Object.hasOwn(reuse, c.id);
  return { noCoverage, candidates, chosen, reused: chosen.filter(isReused).map((c) => reuse[c.id]), run: chosen.filter((c) => !isReused(c)),
    sampled: chosen.length < candidates.length, seed };
}

/**
 * Plans and slices for CI (`cupel mutate --plan`, `--shard`). `planEntries` lists the plan's faults with a
 * time estimate: the fault's measured time last run (`scope.history`), else the median durations of the
 * tests it would run plus `perFaultMs` (a build). `slicePlan` keeps the faults `scope.only` names; the
 * others are another slice's, and count as settled for `targeted`.
 */
export function planEntries({ plan, input, scope = {}, perFaultMs, testsMs }) {
  const history = scope.history ?? {};
  const median = (t) => { const d = [...(t.durationsMs ?? [])].sort((a, b) => a - b); return d.length ? d[Math.floor(d.length / 2)] : 0; };
  const byFile = new Map();
  for (const t of input.tests) if (t.status === 'passed') byFile.set(t.file, (byFile.get(t.file) ?? 0) + median(t));
  const entries = [
    ...plan.noCoverage.map((m) => ({ id: m.id, source: m.source, line: m.line, kind: 'no-coverage', estimateMs: 0 })),
    ...plan.reused.map((m) => ({ id: m.id, source: m.source, line: m.line, kind: 'reused', estimateMs: 0 })),
    ...plan.run.map((c) => ({ id: c.id, source: c.source, line: c.line, kind: 'run',
      estimateMs: Math.round(history[c.id] ?? (perFaultMs + (testsMs ? testsMs(c) : [...c.files].reduce((n, f) => n + (byFile.get(f) ?? 0), 0)))) })),
  ];
  return entries.sort((a, b) => cmp(a.id, b.id));
}

export function slicePlan(plan, only) {
  const keep = new Set(only);
  const elsewhere = [...plan.noCoverage, ...plan.reused, ...plan.run].map((m) => m.id).filter((id) => !keep.has(id));
  return { ...plan, noCoverage: plan.noCoverage.filter((m) => keep.has(m.id)), reused: plan.reused.filter((m) => keep.has(m.id)),
    run: plan.run.filter((c) => keep.has(c.id)), elsewhere };
}

/**
 * The `--test-package` names for a run, or null for `--test-workspace=true`.
 * `packages` is the workspace's [{ name, dir }]; each test file belongs to the
 * package with the deepest directory holding it (as the cargo collector maps
 * `--tests` globs). Null when some file has no package or every package is needed.
 */
export function testPackages(packages, testFiles) {
  const names = new Set();
  for (const file of testFiles) {
    const owner = packages.filter((p) => !p.dir || p.dir === '.' || file.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!owner) return null;
    names.add(owner.name);
  }
  if (!names.size || names.size >= new Set(packages.map((p) => p.name)).size) return null;
  return [...names].sort(cmp);
}

/** The workspace's packages from `cargo metadata --no-deps` (no build, no network), or null when it cannot be read. */
async function workspacePackages(root, env) {
  const cargo = env.CARGO ?? findTool('cargo', env);
  if (!cargo) return null;
  try {
    const result = await execute(cargo, ['metadata', '--offline', '--format-version=1', '--no-deps'], { cwd: root, env, log: noop });
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout).packages.map((p) => ({ name: p.name, dir: relative(root, dirname(p.manifest_path)).split(sep).join('/') }));
  } catch { return null; }
}

export function findTool(command, env) {
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

export function execute(command, args, { cwd, env, log }) {
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

async function runCargoMutants({ tool, root, env, scratch, name, extra, log, tests = ['--test-workspace=true'] }) {
  const out = join(scratch, name);
  const args = ['mutants', '--no-shuffle', ...tests, '--cargo-test-arg=--no-fail-fast', '--colors=never', '-o', out, ...extra];
  const result = await execute(tool, args, { cwd: root, env, log });
  if (!ACCEPTED.has(result.status)) refuse(`cargo-mutants failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().split('\n').slice(-5).join(' | ')}`);
  return join(out, 'mutants.out');
}

export function environmentFor(root, scratch, base, tool) {
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

function escapeRegex(text) { return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); }

/**
 * mutateCargo({ root, input, config, scope, log }) → Cupel mutation object.
 * Plans the scope's mutants (planCargoMutants), runs the chosen ones through
 * cargo-mutants with every catching test recorded, re-runs timeouts once alone
 * with a longer limit, and imports the result with per-test catches.
 * `mutation.maxSeconds` does not apply: cargo-mutants runs to the end.
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
    let plan = planCargoMutants({ input, cfg, wanted, listing, scope });
    if (scope.plan) {
      // cargo-mutants runs the chosen packages' whole suites for each fault, after a build.
      const suiteMs = planEntries({ plan: { noCoverage: [], reused: [], run: [{ id: '', files: new Set(input.tests.map((t) => t.file)) }] }, input, perFaultMs: 0 })[0].estimateMs;
      return { plan: planEntries({ plan, input, scope, perFaultMs: 60_000, testsMs: () => suiteMs }), sampled: plan.sampled, seed: plan.seed };
    }
    if (scope.only) plan = slicePlan(plan, scope.only);
    if (plan.noCoverage.length) log(`mutate-cargo: ${plan.noCoverage.length} mutant(s) on lines no passed test runs are no-coverage, not run`);
    if (plan.sampled) log(`mutate-cargo: sampled ${plan.chosen.length} of ${plan.candidates.length} mutants on covered lines (seed ${plan.seed})`);
    if (plan.reused.length) log(`mutate-cargo: ${plan.reused.length} result(s) reused from an earlier run`);
    // Settled without running here: no-coverage and reused rows.
    const toRun = new Set(plan.run.map((c) => c.id));
    const ran = new Set([...plan.noCoverage.map((m) => m.id), ...plan.chosen.filter((c) => !toRun.has(c.id)).map((c) => c.id), ...(plan.elsewhere ?? [])]);
    let imported = [];
    if (plan.run.length) {
      // Only the packages holding a passed test that runs a mutated line are
      // tested. A test in any other package never executes that line (by the
      // coverage input), so it cannot fail because of the fault: no catch is
      // lost, and the per-test killers stay complete. Cargo still builds the
      // mutated crate as their dependency. The package that owns each mutated
      // file is always included too, so its own programs are rebuilt with the
      // fault: a test that starts another package's program by path would
      // otherwise run a stale, unmutated build.
      const files = new Set([...plan.run.flatMap((c) => [...c.files]), ...plan.run.map((c) => c.source)]);
      const packages = settings.wholeWorkspace ? null : await workspacePackages(root, env);
      const chosenPackages = packages ? testPackages(packages, files) : null;
      const tests = chosenPackages ? chosenPackages.map((name) => `--test-package=${name}`) : ['--test-workspace=true'];
      const diffLines = new Map();
      for (const c of plan.run) {
        if (!diffLines.has(c.source)) diffLines.set(c.source, new Set());
        for (const n of c.diffLines) diffLines.get(c.source).add(n);
      }
      const diffPath = join(scratch, 'scope.diff');
      writeFileSync(diffPath, scopeDiff(root, diffLines));
      const names = plan.run.flatMap((c) => ['--re', `^${escapeRegex(c.name)}$`]);
      const jobs = settings.jobs ?? 1;
      log(`mutate-cargo: cargo-mutants on ${plan.run.length} mutants in ${diffLines.size} files, testing ${chosenPackages ? `packages ${chosenPackages.join(', ')} of ${packages.length}` : 'the workspace'}, ${jobs} job(s)`);
      const outDir = await runCargoMutants({ tool, root, env, scratch, name: 'main', tests, extra: ['--in-diff', diffPath, '-j', String(jobs), ...names, ...(settings.args ?? [])], log });
      const imports = importCargoMutants({ root, input, outDir, testPackages: chosenPackages ?? undefined });
      imported = imports.mutation.mutants;
      const outcomes = JSON.parse(readFileSync(join(outDir, 'outcomes.json'), 'utf8')).outcomes.filter((o) => o.scenario?.Mutant);
      for (const o of outcomes) ran.add(mutantId(o.scenario.Mutant));
      // A timeout under load can be contention, not detection: re-run each once,
      // alone, with ten times the usual limit, and keep that result.
      const timedOut = outcomes.filter((o) => o.summary === 'Timeout').map((o) => o.scenario.Mutant.name);
      if (timedOut.length) {
        log(`mutate-cargo: re-running ${timedOut.length} timed-out mutant(s) alone`);
        const again = await runCargoMutants({ tool, root, env, scratch, name: 'timeouts', tests,
          extra: ['-j', '1', '--timeout-multiplier', '10', ...timedOut.flatMap((n) => ['--re', `^${escapeRegex(n)}$`]), ...(settings.args ?? [])], log });
        const byId = new Map(importCargoMutants({ root, input, outDir: again, testPackages: chosenPackages ?? undefined }).mutation.mutants.map((m) => [m.id, m]));
        imported = imported.map((m) => byId.get(m.id) ?? m);
      }
      const { notes } = imports;
      log(`mutate-cargo: ${imported.length} mutants imported; ${notes.unviable} unviable, ${notes.uncompiled} in code not built for this host, ${notes.pinnedCreditDropped} source-pin catches not credited`);
    }
    const mutants = [...plan.noCoverage, ...plan.reused, ...imported].sort((a, b) => cmp(a.id, b.id));
    for (let i = 1; i < mutants.length; i++) if (mutants[i].id === mutants[i - 1].id) refuse(`duplicate mutant id ${mutants[i].id}`);
    // A fault that still times out, or was caught with no test credited, has no
    // killer: a unit whose own lines hold it is not complete evidence.
    const targeted = targetedUnits({ input, listing, ran, rows: mutants });
    return { mutants, targeted, sampled: plan.sampled, ...(plan.sampled ? { seed: plan.seed } : {}) };
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
