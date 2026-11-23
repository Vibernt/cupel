// Imports cargo-mutants results (`mutants.out`) into Cupel's mutation format,
// with which test caught each fault and how (ARCHITECTURE: "Import
// cargo-mutants"; D10). Read-only: it reads the output directory, the project's
// sources and the coverage input, and writes nothing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { definitions, harnessName, testModuleFiles, testRegions } from '../collect/cargo/tests.mjs';
import { inSourceScope } from '../collect/cargo/coverage.mjs';
import { cmp } from '../engine/order.mjs';
import { parseLog } from './logs.mjs';

export class CargoMutantsError extends Error {
  constructor(message) { super(message); this.name = 'CargoMutantsError'; }
}
const refuse = (message) => { throw new CargoMutantsError(message); };

const sha8 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);

function expand(spec) {
  return (spec ?? '').split(',').filter(Boolean).flatMap((part) => {
    const [a, b = a] = part.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

/** Cupel's id for a cargo-mutants mutant; the same scheme as the JS mutators. */
export function mutantId(mutant) {
  const at = mutant.span.start;
  return `${mutant.file}:${at.line}:${at.column}:${mutant.genre}:${sha8([mutant.function?.function_name ?? null, mutant.replacement, mutant.name])}`;
}

/** The innermost directory holding a Cargo.toml, at or above a source file. */
function packageDir(root, file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(root, dir, 'Cargo.toml'))) return dir === '.' ? '' : dir;
    if (dir === '.' || dir === '' || dir === '/') return '';
    dir = dirname(dir);
  }
}

/** Unified-diff hunks agree with the current source: same commit, unchanged files. */
export function diffMatches(diff, source) {
  const lines = source.split('\n');
  let at = null;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) { at = Number(hunk[1]) - 1; continue; }
    if (at === null || line.startsWith('+') || line === '') continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith(' ') || line.startsWith('-')) {
      if (lines[at] !== line.slice(1)) return false;
      at++;
    }
  }
  return true;
}

const testPhase = (outcome) => outcome.phase_results?.find((phase) => phase.phase === 'Test');

/**
 * importCargoMutants({ root, input, outDir, listing? }) →
 * { mutation: { mutants, targeted, sampled? }, notes: { unviable, uncompiled, doctestOnly, pinnedCreditDropped } }
 *
 * `outDir` is the `mutants.out` directory. `listing` is the complete
 * `cargo mutants --list --json` array for the same tree and configuration;
 * without it no unit is `targeted` and `sampled` is left out.
 */
export function importCargoMutants({ root, input, outDir, listing }) {
  const outcomesPath = join(outDir, 'outcomes.json');
  if (!existsSync(outcomesPath)) refuse(`no outcomes.json in ${outDir}`);
  const outcomes = JSON.parse(readFileSync(outcomesPath, 'utf8'));
  if (!Array.isArray(outcomes.outcomes)) refuse('outcomes.json has no outcomes list');
  const baseline = outcomes.outcomes.find((o) => o.scenario === 'Baseline');
  if (baseline && baseline.summary !== 'Success') refuse(`cargo-mutants baseline did not pass (${baseline.summary})`);
  const results = outcomes.outcomes.filter((o) => o.scenario?.Mutant);
  const mutantsJson = existsSync(join(outDir, 'mutants.json')) ? JSON.parse(readFileSync(join(outDir, 'mutants.json'), 'utf8')) : [];
  const diffs = new Map(mutantsJson.map((m) => [m.name, m.diff]));

  // Every catching test must be visible: cargo test needs --no-fail-fast, and
  // in a multi-package workspace every package's tests must run.
  const severalPackages = new Set(Object.keys(input.sources).map((file) => packageDir(root, file))).size > 1;
  for (const o of results) {
    const argv = testPhase(o)?.argv;
    if (!argv) continue; // unviable mutants never reach the test phase
    if (argv.some((arg) => arg === 'nextest')) refuse('cargo-mutants ran tests with nextest, whose logs Cupel cannot read per test yet; rerun with test_tool = "cargo"');
    if (!argv.includes('--no-fail-fast')) refuse('cargo-mutants ran cargo test without --no-fail-fast, so later catching tests are missing; rerun with --cargo-test-arg=--no-fail-fast');
    const onePackage = argv.some((arg) => arg.startsWith('--package=') || arg === '-p' || arg === '--package');
    if (onePackage && !argv.includes('--workspace') && severalPackages) {
      refuse('cargo-mutants tested only the mutated package, so tests in other packages never saw its faults; rerun with --test-workspace=true');
    }
  }

  const tests = new Map(input.tests.map((t) => [t.id, t]));
  const sourceDefs = definitions(root);
  const regions = new Map();
  const regionsFor = (file) => {
    if (!regions.has(file)) {
      const path = join(root, file);
      regions.set(file, existsSync(path) ? testRegions(readFileSync(path, 'utf8')) : []);
    }
    return regions.get(file);
  };
  const pinned = new Set((input.brittleness ?? []).filter((b) => b.kind === 'source-text').map((b) => b.test));
  const testModules = testModuleFiles(Object.keys(input.sources).filter((f) => f.endsWith('.rs') && existsSync(join(root, f)))
    .map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  const coveredLines = new Map();
  for (const row of Object.values(input.coverage?.byTest ?? {})) for (const [file, spec] of Object.entries(row)) {
    if (!coveredLines.has(file)) coveredLines.set(file, new Set());
    for (const n of expand(spec)) coveredLines.get(file).add(n);
  }
  for (const [file, lines] of Object.entries(input.coverage?.setup ?? {}).flatMap(([, entry]) => Object.entries(entry))) {
    if (!coveredLines.has(file)) coveredLines.set(file, new Set());
    for (const n of expand(lines)) coveredLines.get(file).add(n);
  }
  const coverable = new Map(Object.entries(input.sources).map(([file, s]) => [file, new Set(expand(s.coverable))]));

  // Binary → crate source, from every log's verbose build lines.
  const logs = new Map();
  const compiled = new Map();
  for (const o of results) {
    const path = join(outDir, o.log_path);
    if (!existsSync(path)) refuse(`missing cargo-mutants log ${o.log_path}`);
    const parsed = parseLog(readFileSync(path, 'utf8'));
    logs.set(o.log_path, parsed);
    for (const [binary, info] of parsed.compiled) compiled.set(binary, info);
  }
  if (baseline?.log_path && existsSync(join(outDir, baseline.log_path))) {
    for (const [binary, info] of parseLog(readFileSync(join(outDir, baseline.log_path), 'utf8')).compiled) compiled.set(binary, info);
  }

  const idCache = new Map();
  const cupelId = (binary, name) => {
    const key = `${binary}\0${name}`;
    if (idCache.has(key)) return idCache.get(key);
    const info = compiled.get(binary);
    if (!info) refuse(`cargo-mutants log runs ${binary} but no log shows how it was compiled`);
    const crateDir = packageDir(root, info.src);
    const crateRoot = join(root, info.src);
    const candidates = sourceDefs.filter((d) => (!crateDir || d.file.startsWith(`${crateDir}/`)) && harnessName(d, root, crateRoot) === name);
    if (candidates.length > 1) refuse(`ambiguous Rust test definition: ${name}`);
    const file = candidates[0]?.file ?? info.src;
    const id = `${file}::${name.split('::').join(' > ')}`;
    idCache.set(key, id);
    return id;
  };

  const notes = { unviable: 0, uncompiled: 0, doctestOnly: 0, pinnedCreditDropped: 0 };
  const uncertain = new Set(); // source\0line of detected faults no test could be credited with
  const mutants = [];
  for (const o of results) {
    const m = o.scenario.Mutant;
    const file = m.file.replaceAll('\\', '/');
    if (o.summary === 'Unviable') { notes.unviable++; continue; }
    const line = m.span.start.line;
    // A fault on a line the coverage input cannot count is in code not built
    // for this host (or outside source scope): cargo-mutants calls it missed,
    // but no test could ever run it here.
    if (!coverable.get(file)?.has(line)) { notes.uncompiled++; continue; }
    if (!existsSync(join(root, file))) refuse(`${file} is not under ${root}; run from the project root or pass --root`);
    const diff = diffs.get(m.name);
    if (diff && !diffMatches(diff, readFileSync(join(root, file), 'utf8'))) refuse(`${file} changed since cargo-mutants ran (${m.name})`);
    const base = { id: mutantId(m), source: file, line, operator: m.genre, description: m.name.replace(/^[^:]+:\d+:\d+: /, '') };
    if (o.summary === 'MissedMutant') {
      mutants.push({ ...base, status: coveredLines.get(file)?.has(line) ? 'survived' : 'no-coverage' });
    } else if (o.summary === 'Timeout') {
      mutants.push({ ...base, status: 'timeout', killedBy: [] });
      uncertain.add(`${file}\0${line}`);
    } else if (o.summary === 'CaughtMutant') {
      const parsed = logs.get(o.log_path);
      const kinds = {};
      for (const run of parsed.runs) for (const failure of run.failed) {
        const id = cupelId(run.binary, failure.name);
        if (!tests.has(id)) refuse(`cargo-mutants reports test ${id}, which the coverage input does not have; collect coverage and run cargo-mutants on the same commit`);
        if (pinned.has(id)) { notes.pinnedCreditDropped++; continue; }
        const at = failure.location;
        const inTest = failure.unmetPanic || failure.returnedError || !at
          || !inSourceScope(at.file) || testModules.has(at.file) || regionsFor(at.file).some(([a, b]) => at.line >= a && at.line <= b);
        // A test that failed twice keeps its strongest kind.
        if (kinds[id] !== 'assertion') kinds[id] = inTest ? 'assertion' : 'panic';
      }
      const killedBy = Object.keys(kinds).sort(cmp);
      if (parsed.nextest) refuse(`cannot read which test caught ${m.name}: nextest logs are not supported yet`);
      if (!killedBy.length) {
        // Detected, but no test can be credited: a doctest, or a test binary
        // that crashed before reporting. The fault counts as caught; tests
        // whose lines hold it are no longer complete evidence (never "catches nothing").
        if (parsed.doctestFailures) notes.doctestOnly++;
        else if (parsed.runs.some((run) => run.died)) notes.unattributed = (notes.unattributed ?? 0) + 1;
        else if (!parsed.runs.some((run) => run.failed.length)) refuse(`cannot tell which test caught ${m.name} from its log; was cargo test's output changed?`);
        uncertain.add(`${file}\0${line}`);
      }
      mutants.push({ ...base, status: 'killed', killedBy, ...(killedBy.length ? { killKinds: Object.fromEntries(killedBy.map((id) => [id, kinds[id]])) } : {}) });
    } else refuse(`unknown cargo-mutants outcome ${o.summary} for ${m.name}`);
  }
  mutants.sort((a, b) => cmp(a.id, b.id));
  const ids = new Set();
  for (const m of mutants) { if (ids.has(m.id)) refuse(`duplicate mutant id ${m.id}`); ids.add(m.id); }

  const mutation = { mutants, targeted: [] };
  if (listing) {
    const ran = new Set(results.map((o) => mutantId(o.scenario.Mutant)));
    const listed = listing.map((m) => ({ id: mutantId(m), file: m.file.replaceAll('\\', '/'), line: m.span.start.line }));
    mutation.sampled = listed.some((m) => !ran.has(m.id));
    const units = new Map();
    for (const t of input.tests) {
      const unit = t.unit ?? t.id;
      if (!units.has(unit)) units.set(unit, new Map());
      for (const [file, spec] of Object.entries(input.coverage?.byTest?.[t.id] ?? {})) {
        if (!units.get(unit).has(file)) units.get(unit).set(file, new Set());
        for (const n of expand(spec)) units.get(unit).get(file).add(n);
      }
    }
    for (const [unit, own] of [...units].sort(([a], [b]) => cmp(a, b))) {
      const mine = listed.filter((m) => own.get(m.file)?.has(m.line));
      const unsure = [...own].some(([file, set]) => [...set].some((n) => uncertain.has(`${file}\0${n}`)));
      if (mine.length && mine.every((m) => ran.has(m.id)) && !unsure) mutation.targeted.push(unit);
    }
  }
  return { mutation, notes };
}
