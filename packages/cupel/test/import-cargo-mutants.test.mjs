import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCargoMutants, mutantId, diffMatches } from '../src/mutate-cargo/import.mjs';
import { parseLog, rustcCompile } from '../src/mutate-cargo/logs.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';

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

// Live cargo-mutants runs need the tool: CUPEL_CARGO_MUTANTS names the binary, or it is found on PATH.
import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
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
