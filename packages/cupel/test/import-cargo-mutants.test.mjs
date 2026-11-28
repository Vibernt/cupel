import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCargoMutants, mutantId, diffMatches, packageNames } from '../src/mutate-cargo/import.mjs';
import { mutateCargo, planCargoMutants, testPackages, wantedLines } from '../src/mutate-cargo/run.mjs';
import { sample } from '../src/mutate/operators.mjs';
import { effectiveConfig } from '../src/engine/config.mjs';
import { parseLog, rustcCompile } from '../src/mutate-cargo/logs.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';

// The stand-in is a Node script, and Windows starts only real executables (cargo-mutants.exe is one).
const FAKE_SKIP = process.platform === 'win32' && 'the cargo-mutants stand-in is a script, which Windows cannot start directly';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = join(repo, 'spec/conformance/adapters/cargo-workspace');
const fixture = fileURLToPath(new URL('fixtures/cargo-mutants-ws/', import.meta.url));
const input = JSON.parse(readFileSync(join(fixture, 'input.json'), 'utf8'));
const listing = JSON.parse(readFileSync(join(fixture, 'listing.json'), 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((name) => [name,
  JSON.parse(readFileSync(join(repo, `spec/schemas/${name}.schema.json`), 'utf8'))]));
const outDir = join(fixture, 'mutants.out');
const EVEN = 'core/src/lib.rs::tests > even';
const ODD = 'core/src/lib.rs::tests > odd_panics';
const RUN = 'cli/tests/run.rs::prints_secret';
const KEY = 'core/tests/secrets.rs::detects_key';

function scratchCopy(edit) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const dir = mkdtempSync(join(repo, '.scratch/cargo-mutants-'));
  cpSync(outDir, dir, { recursive: true });
  const outcomes = JSON.parse(readFileSync(join(dir, 'outcomes.json'), 'utf8'));
  edit(outcomes, dir);
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify(outcomes));
  return dir;
}

test('cargo-mutants import: statuses, killers, catch kinds, exclusions and targeted units', () => {
  const { mutation, notes } = importCargoMutants({ root, input, outDir, listing });
  assert.deepEqual(notes, { unviable: 0, uncompiled: 2, doctestOnly: 0, pinnedCreditDropped: 0 });
  const by = Object.fromEntries(mutation.mutants.map((m) => [m.description, m]));
  assert.equal(mutation.mutants.length, 17);
  assert.deepEqual(by['replace % with / in halve'].killKinds, { [EVEN]: 'panic' });
  assert.deepEqual(by['replace != with == in halve'].killKinds, { [EVEN]: 'panic', [ODD]: 'assertion' });
  assert.deepEqual(by['replace halve -> i32 with 0'].killKinds, { [EVEN]: 'assertion', [ODD]: 'assertion' });
  assert.deepEqual(by['replace main with ()'].killedBy, [RUN]);
  assert.deepEqual(by['replace > with < in looks_secret'].killedBy, [RUN, KEY]);
  for (const name of ['replace && with || in looks_secret', 'replace > with >= in looks_secret', 'replace looks_secret -> bool with true']) {
    assert.equal(by[name].status, 'survived', name);
  }
  assert.equal(by['replace untested -> u8 with 0'].status, 'no-coverage');
  assert.equal(mutation.mutants.some((m) => m.source === 'core/src/wasm_only.rs'), false);
  assert.deepEqual(mutation.targeted, [RUN, EVEN, ODD, KEY].sort());
  assert.equal(mutation.sampled, false);
  const merged = { ...input, mutation };
  assert.deepEqual(validate(schemas.input, merged), []);
  const { report, exit } = run('report', { input: merged }, {}, {}, schemas);
  assert.equal(exit, 0, JSON.stringify(report.diagnostics));
});

test('cargo-mutants import without a listing marks nothing targeted and leaves sampled out', () => {
  const { mutation } = importCargoMutants({ root, input, outDir });
  assert.deepEqual(mutation.targeted, []);
  assert.equal('sampled' in mutation, false);
  assert.equal(mutantId(listing[0]), mutantId(listing[0]));
});

test('cargo-mutants import refuses incomplete or mismatched runs', () => {
  const cases = [
    [(o) => { for (const x of o.outcomes) for (const p of x.phase_results ?? []) p.argv = p.argv.filter((a) => a !== '--no-fail-fast'); }, /--no-fail-fast/],
    [(o) => { for (const x of o.outcomes) for (const p of x.phase_results ?? []) if (p.phase === 'Test') p.argv = [...p.argv.filter((a) => a !== '--workspace'), '--package=ws-core@0.1.0']; }, /--test-workspace=true/],
    [(o) => { o.outcomes.find((x) => x.scenario === 'Baseline').summary = 'Failure'; }, /baseline did not pass/],
    [(o, dir) => {
      const caught = o.outcomes.find((x) => x.summary === 'CaughtMutant' && x.scenario.Mutant.file === 'cli/src/main.rs');
      const log = join(dir, caught.log_path);
      writeFileSync(log, readFileSync(log, 'utf8').replaceAll('prints_secret', 'prints_secret_renamed'));
    }, /coverage input does not have/],
    [(o, dir) => {
      const mutants = JSON.parse(readFileSync(join(dir, 'mutants.json'), 'utf8'));
      for (const m of mutants) if (m.file === 'core/src/secrets.rs') m.diff = m.diff.replace('pub fn looks_secret', 'pub fn looks_private');
      writeFileSync(join(dir, 'mutants.json'), JSON.stringify(mutants));
    }, /changed since cargo-mutants ran/],
  ];
  for (const [edit, pattern] of cases) {
    const dir = scratchCopy(edit);
    try { assert.throws(() => importCargoMutants({ root, input, outDir: dir }), pattern); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('review fixes: crashed binaries, timeouts and missed-only single-package runs never yield "catches nothing"', () => {
  const caughtOf = (o, file, text) => o.outcomes.find((x) => x.summary === 'CaughtMutant' && x.scenario.Mutant.file === file && x.scenario.Mutant.name.includes(text));
  // A binary that crashed: the fault counts as caught, no test is credited, and the unit stops being complete evidence.
  let dir = scratchCopy((o, d) => {
    const c = caughtOf(o, 'core/src/secrets.rs', 'with false');
    const log = join(d, c.log_path);
    writeFileSync(log, readFileSync(log, 'utf8').replace(/test detects_key \.\.\. FAILED[\s\S]*?test result: FAILED[^\n]*\n/, "error: process didn't exit successfully: `x` (signal: 6, SIGABRT: process abort signal)\n")
      .replace(/test prints_secret \.\.\. FAILED[\s\S]*?test result: FAILED[^\n]*\n/, "error: process didn't exit successfully: `y` (signal: 6, SIGABRT: process abort signal)\n"));
  });
  try {
    const { mutation, notes } = importCargoMutants({ root, input, outDir: dir, listing });
    const row = mutation.mutants.find((m) => m.description === 'replace looks_secret -> bool with false');
    assert.equal(row.status, 'killed');
    assert.deepEqual(row.killedBy, []);
    assert.equal(notes.unattributed, 1);
    assert.equal(mutation.targeted.includes(KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // A timeout: the unit holding it is not complete evidence either.
  dir = scratchCopy((o) => { const c = caughtOf(o, 'core/src/secrets.rs', 'with false'); c.summary = 'Timeout'; });
  try {
    const { mutation } = importCargoMutants({ root, input, outDir: dir, listing });
    assert.equal(mutation.targeted.includes(KEY), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // Single-package testing is refused even when every fault was missed.
  dir = scratchCopy((o) => {
    o.outcomes = o.outcomes.filter((x) => x.scenario === 'Baseline' || x.summary === 'MissedMutant');
    for (const x of o.outcomes) for (const p of x.phase_results ?? []) if (p.phase === 'Test') p.argv = [...p.argv.filter((a) => a !== '--workspace'), '--package=ws-core@0.1.0'];
  });
  try { assert.throws(() => importCargoMutants({ root, input, outDir: dir }), /--test-workspace=true/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  // nextest logs are refused rather than misread.
  dir = scratchCopy((o) => { for (const x of o.outcomes) for (const p of x.phase_results ?? []) if (p.phase === 'Test') p.argv = ['cargo', 'nextest', 'run', '--no-fail-fast', '--workspace']; });
  try { assert.throws(() => importCargoMutants({ root, input, outDir: dir }), /nextest/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a test that reads source text gets no catch credit (K6: pins never earn kills)', () => {
  const pinned = { ...input, brittleness: [...(input.brittleness ?? []), { test: KEY, kind: 'source-text', line: 3 }] };
  const { mutation, notes } = importCargoMutants({ root, input: pinned, outDir });
  assert.equal(mutation.mutants.some((m) => m.killedBy?.includes(KEY)), false);
  assert.equal(notes.pinnedCreditDropped, 3);
});

test('cargo-mutants logs: Windows binaries, rustc wrappers, deaths and doctests', () => {
  assert.deepEqual(rustcCompile("sccache rustc --crate-name ws_core --edition=2021 core\\src\\lib.rs --test -C extra-filename=-ab12 --out-dir x"),
    { crate: 'ws_core', src: 'core/src/lib.rs', test: true, binary: 'ws_core-ab12' });
  assert.equal(rustcCompile('rustdoc --crate-name ws_core --test core/src/lib.rs'), null);
  const log = [
    '*** C:\\cargo.exe test --verbose --workspace --no-fail-fast',
    '     Running `C:\\w\\target\\debug\\deps\\ws_core-ab12.exe`',
    'test tests::a ... FAILED',
    'test tests::b ... FAILED',
    'failures:',
    '---- tests::a stdout ----',
    "thread 'tests::a' panicked at core\\src\\lib.rs:7:9:",
    '---- tests::b stdout ----',
    'Error: "boom"',
    'error: test failed, to rerun pass `-p ws-core --lib`',
    '     Running `C:\\w\\target\\debug\\deps\\run-cd34.exe`',
    "error: process didn't exit successfully: `C:\\w\\target\\debug\\deps\\run-cd34.exe` (exit code: 0xc00000fd, STATUS_STACK_OVERFLOW)",
    '   Doc-tests ws_core',
    '     Running `rustdoc --edition=2021 --crate-name ws_core --test core/src/lib.rs`',
    'test core/src/lib.rs - halve (line 3) ... FAILED',
    '*** result: Failure(101)',
  ].join('\r\n');
  const parsed = parseLog(log);
  assert.deepEqual(parsed.runs, [
    { binary: 'ws_core-ab12', failed: [{ name: 'tests::a', location: { file: 'core/src/lib.rs', line: 7 } }, { name: 'tests::b', returnedError: true }], died: false },
    { binary: 'run-cd34', failed: [], died: true },
  ]);
  assert.equal(parsed.doctestFailures, 1);
  assert.equal(diffMatches('--- a\n+++ b\n@@ -2,2 +2,2 @@\n x\n-y\n+z\n', 'w\nx\ny\n'), true);
  assert.equal(diffMatches('--- a\n+++ b\n@@ -2,2 +2,2 @@\n x\n-q\n+z\n', 'w\nx\ny\n'), false);
});

test('cargo-mutants import accepts a run Cupel restricted to chosen packages, and no other single-package run', () => {
  assert.deepEqual(packageNames(['cargo', 'test', '--package=ws-cli@0.1.0', '-p', 'ws-core', '-pws-glue', '--no-fail-fast']), ['ws-cli', 'ws-core', 'ws-glue']);
  const dir = scratchCopy((o) => {
    for (const x of o.outcomes) for (const p of x.phase_results ?? []) if (p.phase === 'Test') p.argv = [...p.argv.filter((a) => a !== '--workspace'), '--package=ws-cli@0.1.0', '--package=ws-core@0.1.0'];
  });
  try {
    assert.throws(() => importCargoMutants({ root, input, outDir: dir }), /--test-workspace=true/);
    assert.throws(() => importCargoMutants({ root, input, outDir: dir, testPackages: ['ws-core', 'ws-glue'] }), /--test-workspace=true/);
    assert.equal(importCargoMutants({ root, input, outDir: dir, testPackages: ['ws-cli', 'ws-core'] }).mutation.mutants.length, 17);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const CONFIG_SCHEMA = JSON.parse(readFileSync(join(repo, 'packages/cupel/schemas/config.schema.json'), 'utf8'));
const planFor = (scope, config = {}) => {
  const cfg = effectiveConfig(config, CONFIG_SCHEMA);
  return planCargoMutants({ input, cfg, wanted: wantedLines(input, cfg, scope), listing, scope });
};
const imported = importCargoMutants({ root, input, outDir }).mutation.mutants;
const SECRETS_AND_GLUE = { changed: { 'core/src/secrets.rs': '1-3', 'glue/src/lib.rs': '1-3' } };

test('mutate-cargo plan: mutants on lines no passed test runs are no-coverage rows, exactly as an import gives them, and never run', () => {
  const plan = planFor(SECRETS_AND_GLUE);
  assert.deepEqual(plan.noCoverage, imported.filter((m) => m.source === 'glue/src/lib.rs'));
  assert.equal(plan.noCoverage.length, 2);
  assert.ok(plan.noCoverage.every((m) => m.status === 'no-coverage' && !('killedBy' in m)));
  assert.deepEqual(plan.run.map((c) => c.source), Array(6).fill('core/src/secrets.rs'));
  assert.deepEqual([...new Set(plan.run.flatMap((c) => [...c.files]))].sort(), ['cli/tests/run.rs', 'core/tests/secrets.rs']);
  assert.equal(plan.sampled, false);
});

test('mutate-cargo plan: only packages holding a passed test that runs the code are tested', () => {
  const packages = [{ name: 'ws-core', dir: 'core' }, { name: 'ws-cli', dir: 'cli' }, { name: 'ws-glue', dir: 'glue' }];
  assert.deepEqual(testPackages(packages, ['core/tests/secrets.rs', 'cli/tests/run.rs']), ['ws-cli', 'ws-core']);
  assert.deepEqual(testPackages(packages, ['core/src/lib.rs']), ['ws-core']);
  assert.equal(testPackages(packages, ['core/src/lib.rs', 'cli/tests/run.rs', 'glue/tests/x.rs']), null, 'every package: --test-workspace=true');
  assert.equal(testPackages(packages, ['tools/tests/x.rs']), null, 'a test outside every package: the whole workspace');
  assert.deepEqual(testPackages([{ name: 'root', dir: '' }, { name: 'inner', dir: 'crates/inner' }], ['crates/inner/tests/a.rs']), ['inner']);
});

test('mutate-cargo plan: maxMutants keeps a seeded sample, targeted units first and whole', () => {
  const all = planFor({ changed: { 'core/src/secrets.rs': '1-3', 'core/src/lib.rs': '5-10', 'cli/src/main.rs': '1-8' } });
  assert.equal(all.candidates.length, 15);
  const capped = planFor({ changed: { 'core/src/secrets.rs': '1-3', 'core/src/lib.rs': '5-10', 'cli/src/main.rs': '1-8' } }, { mutation: { maxMutants: 4, seed: 7 } });
  assert.deepEqual(capped.chosen.map((c) => c.id), sample(all.candidates, 4, 7).map((c) => c.id));
  assert.equal(capped.sampled, true);
  assert.equal(capped.seed, 7);
  const again = planFor({ changed: { 'core/src/secrets.rs': '1-3', 'core/src/lib.rs': '5-10', 'cli/src/main.rs': '1-8' } }, { mutation: { maxMutants: 4, seed: 7 } });
  assert.deepEqual(again.chosen.map((c) => c.id), capped.chosen.map((c) => c.id), 'same seed, same mutants');
  // A targeted unit whose own-line mutants fit the cap is taken whole, before anything else.
  const targeted = planFor({ changed: { 'core/src/secrets.rs': '1-3', 'cli/src/main.rs': '1-8' }, targeted: [EVEN] }, { mutation: { maxMutants: 8 } });
  assert.deepEqual(targeted.chosen.map((c) => c.source), Array(8).fill('core/src/lib.rs'));
  assert.equal(targeted.sampled, true);
});

/** A stand-in for cargo-mutants: lists the fixture's mutants and "runs" by copying the fixture output for the --re names. */
function fakeCargoMutants() {
  const dir = mkdtempSync(join(repo, '.scratch/cargo-mutants-fake-'));
  const script = join(dir, 'cargo-mutants.cjs'); // CommonJS: the repository's package.json makes .js and bare files ESM
  writeFileSync(script, `#!/usr/bin/env node
const { appendFileSync, cpSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'argv.log'))}, JSON.stringify(args) + '\\n');
if (args.includes('--list')) { process.stdout.write(readFileSync(${JSON.stringify(join(fixture, 'listing.json'))}, 'utf8')); process.exit(0); }
const out = join(args[args.indexOf('-o') + 1], 'mutants.out');
cpSync(${JSON.stringify(outDir)}, out, { recursive: true });
const res = args.flatMap((a, i) => (a === '--re' ? [new RegExp(args[i + 1])] : []));
const packages = args.filter((a) => a.startsWith('--test-package=')).map((a) => '--package=' + a.slice(15) + '@0.1.0');
const outcomes = JSON.parse(readFileSync(join(out, 'outcomes.json'), 'utf8'));
outcomes.outcomes = outcomes.outcomes.filter((o) => o.scenario === 'Baseline' || res.some((re) => re.test(o.scenario.Mutant.name)));
if (packages.length) for (const o of outcomes.outcomes) for (const p of o.phase_results ?? []) p.argv = [...p.argv.filter((a) => a !== '--workspace'), ...packages];
writeFileSync(join(out, 'outcomes.json'), JSON.stringify(outcomes));
process.exit(2);
`);
  chmodSync(script, 0o755);
  const project = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-mutants-project-')));
  cpSync(root, project, { recursive: true });
  const calls = () => readFileSync(join(dir, 'argv.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { script, project, calls, done: () => { rmSync(dir, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); } };
}

test('mutateCargo: reused rows are copied and not run; no-coverage rows never start cargo-mutants', { skip: FAKE_SKIP }, async () => {
  const fake = fakeCargoMutants();
  try {
    const config = { runners: { cargo: { mutants: { command: fake.script } } } };
    const secrets = imported.filter((m) => m.source === 'core/src/secrets.rs');
    const reuse = Object.fromEntries(secrets.map((m) => [m.id, { ...m, reused: true }]));
    // Everything reused or uncovered: only the listing runs.
    const all = await mutateCargo({ root: fake.project, input, config, scope: { ...SECRETS_AND_GLUE, reuse } });
    assert.deepEqual(fake.calls().map((args) => args.includes('--list')), [true]);
    assert.deepEqual(all.mutants, [...imported.filter((m) => m.source === 'glue/src/lib.rs'), ...secrets.map((m) => ({ ...m, reused: true }))].sort((a, b) => (a.id < b.id ? -1 : 1)));
    assert.equal(all.sampled, false);
    assert.equal('seed' in all, false);
    assert.ok(all.targeted.includes(KEY), JSON.stringify(all.targeted));
    // One reused: the other five run, testing only the packages whose tests run secrets.rs.
    const kept = secrets.find((m) => m.description === 'replace looks_secret -> bool with true');
    const some = await mutateCargo({ root: fake.project, input, config, scope: { ...SECRETS_AND_GLUE, reuse: { [kept.id]: { ...kept, reused: true } } } });
    const run = fake.calls().at(-1);
    assert.equal(run.includes('--test-workspace=true'), false);
    assert.deepEqual(run.filter((a) => a.startsWith('--test-package=')), ['--test-package=ws-cli', '--test-package=ws-core']);
    assert.ok(run.includes('--in-diff') && run.includes('--cargo-test-arg=--no-fail-fast'));
    const names = run.flatMap((a, i) => (run[i - 1] === '--re' ? [a] : []));
    assert.equal(names.length, 5);
    assert.equal(names.some((n) => n.includes('with true')), false);
    assert.deepEqual(some.mutants, all.mutants.map((m) => (m.id === kept.id || m.source !== 'core/src/secrets.rs' ? m : secrets.find((s) => s.id === m.id))));
    assert.ok(some.targeted.includes(KEY));
    // Absent reuse with a cap: a seeded sample runs and the result says so.
    const capped = await mutateCargo({ root: fake.project, input, config: { ...config, mutation: { maxMutants: 2, seed: 3 } }, scope: SECRETS_AND_GLUE });
    assert.equal(fake.calls().at(-1).filter((a) => a === '--re').length, 2);
    assert.equal(capped.mutants.filter((m) => m.status !== 'no-coverage').length, 2);
    assert.equal(capped.sampled, true);
    assert.equal(capped.seed, 3);
    assert.equal(capped.targeted.includes(KEY), false, 'a unit with unsampled mutants is not complete evidence');
  } finally { fake.done(); }
});

// Live cargo-mutants runs need the tool: CUPEL_CARGO_MUTANTS names the binary, or it is found on PATH.
import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const tool = process.env.CUPEL_CARGO_MUTANTS
  ?? (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, process.platform === 'win32' ? 'cargo-mutants.exe' : 'cargo-mutants')).find((path) => existsSync(path));
const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const llvm = rustc.status === 0 && (process.env.PATH ?? '').split(delimiter).some((dir) => existsSync(join(dir, process.platform === 'win32' ? 'llvm-cov.exe' : 'llvm-cov')));
/** SHA-256 over every file's path and bytes, skipping the named top-level entries. */
function treeHash(dir, skip = []) {
  const hash = createHash('sha256');
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && skip.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(path);
      else hash.update(`${path}\0`).update(readFileSync(join(dir, path))).update('\0');
    }
  };
  walk('');
  return hash.digest('hex');
}
const liveSkip = !tool ? 'cargo-mutants unavailable (set CUPEL_CARGO_MUTANTS or put it on PATH)' : !llvm ? 'LLVM tools unavailable on PATH' : false;

test('CLI report runs cargo-mutants on critical code and records how each test caught faults', { skip: liveSkip, timeout: 600_000 }, () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const project = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-mutants-cli-')));
  try {
    cpSync(root, project, { recursive: true });
    writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool } } } }));
    const before = treeHash(project, ['target']);
    const env = { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-target-mutants-cli') };
    const outDir = mkdtempSync(join(repo, '.scratch/cargo-mutants-cli-out-'));
    const out = join(outDir, 'input.json');
    const report = spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), 'report', '--runs', '1', '--out', out, '--json'],
      { cwd: project, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(report.status, 0, report.stderr);
    const saved = JSON.parse(readFileSync(out, 'utf8'));
    const rows = saved.mutation.mutants;
    assert.ok(rows.length >= 6 && rows.every((m) => m.source === 'core/src/secrets.rs'), JSON.stringify(rows));
    assert.deepEqual(rows.filter((m) => m.status === 'survived').map((m) => m.description).sort(),
      ['replace && with || in looks_secret', 'replace > with >= in looks_secret', 'replace looks_secret -> bool with true']);
    assert.ok(rows.filter((m) => m.status === 'killed').every((m) => m.killKinds?.[KEY] === 'assertion'));
    assert.deepEqual(validate(schemas.input, saved), []);
    assert.equal(treeHash(project, ['target']), before, 'the assessed project is never changed; only Cargo writes target/');
    rmSync(outDir, { recursive: true, force: true });
  } finally { rmSync(project, { recursive: true, force: true }); }
});
