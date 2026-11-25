// Cupel's own Rust runner (backend "cupel", D21) gives the same rows as cargo-mutants on the fixture workspace,
// with and without switchable faults, and leaves the project unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog } from '../src/mutate-cargo/logs.mjs';
import { applyMutant, missingResults, scratchWrite, switchable, targetOf } from '../src/mutate-cargo/fast.mjs';
import { symlinkSync } from 'node:fs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repo, 'spec/conformance/adapters/cargo-workspace');
const tool = process.env.CUPEL_CARGO_MUTANTS
  ?? (process.env.PATH ?? '').split(delimiter).map((d) => join(d, process.platform === 'win32' ? 'cargo-mutants.exe' : 'cargo-mutants')).find((p) => existsSync(p));
const llvm = spawnSync('rustc', ['-vV']).status === 0 && (process.env.PATH ?? '').split(delimiter).some((d) => existsSync(join(d, process.platform === 'win32' ? 'llvm-cov.exe' : 'llvm-cov')));
const skip = !tool ? 'cargo-mutants unavailable (set CUPEL_CARGO_MUTANTS)' : !llvm ? 'LLVM tools unavailable on PATH' : false;

test('missingResults names the tests that reported nothing, so zero executed tests is never a pass', () => {
  const log = (body) => parseLog(`*** cargo test --verbose\n     Running \`/t/target/debug/deps/app-1a2b --exact a::x\`\n${body}\n`, { reported: true });
  const ok = log('running 2 tests\ntest a::x ... ok\ntest a::y ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed');
  assert.deepEqual(missingResults(ok, ['a::x', 'a::y']), { missing: [] });
  assert.deepEqual(ok.runs[0].failed.map((f) => f.name), ['a::y']);
  const none = log('running 0 tests\n\ntest result: ok. 0 passed; 0 failed');
  assert.deepEqual(missingResults(none, ['b::z', 'a::x']), { missing: ['a::x', 'b::z'] });
  assert.deepEqual(missingResults(log('test a::x ... ignored, slow'), ['a::x']), { missing: [] });
  assert.deepEqual(missingResults(parseLog('', { reported: true }), ['a::x']), { missing: ['a::x'] });
});

test('applyMutant replaces a span counted in Unicode scalar values', () => {
  const text = 'fn a() {\n  let s = "é😀"; x == y\n}\n';
  const out = applyMutant(text, { name: 't', span: { start: { line: 2, column: 19 }, end: { line: 2, column: 21 } }, replacement: '!=' });
  assert.equal(out, 'fn a() {\n  let s = "é😀"; x != y\n}\n');
});

test('only faults that keep the grouping are switched: regrouping operators get a build of their own', () => {
  const text = 'fn f(a: bool, b: bool, c: bool, x: i32, y: i32) -> bool {\n  a && b && c || x + y * 2 == 3\n}\n';
  const at = (col, len, replacement) => ({ genre: 'BinaryOperator', replacement, span: { start: { line: 2, column: col }, end: { line: 2, column: col + len } } });
  assert.equal(switchable(text, at(5, 2, '||')), false, 'a && b || c regroups');
  assert.equal(switchable(text, at(15, 2, '&&')), false);
  assert.equal(switchable(text, at(20, 1, '-')), true, '+ to - keeps the level');
  assert.equal(switchable(text, at(20, 1, '*')), false, '+ to * regroups');
  assert.equal(switchable(text, at(28, 2, '!=')), true);
  const neg = 'fn g() -> i8 {\n  -128i8 + -x\n}\n';
  assert.equal(switchable(neg, { genre: 'UnaryOperator', replacement: '', span: { start: { line: 2, column: 3 }, end: { line: 2, column: 4 } } }), false, 'deleting - before a literal');
  assert.equal(switchable(neg, { genre: 'UnaryOperator', replacement: '', span: { start: { line: 2, column: 12 }, end: { line: 2, column: 13 } } }), true);
  assert.equal(switchable(text, { genre: 'FnValue', replacement: 'true', span: { start: { line: 2, column: 3 }, end: { line: 2, column: 30 } } }), true);
});

test('scratch writes never go through a link out of the copy', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const outside = realpathSync(mkdtempSync(join(repo, '.scratch/fast-outside-')));
  const scratch = realpathSync(mkdtempSync(join(repo, '.scratch/fast-scratch-')));
  try {
    writeFileSync(join(outside, 'real.rs'), 'original');
    mkdirSync(join(scratch, 'src'));
    symlinkSync(join(outside, 'real.rs'), join(scratch, 'src/linked.rs'));
    scratchWrite(scratch, join(scratch, 'src/linked.rs'), 'fault');
    assert.equal(readFileSync(join(outside, 'real.rs'), 'utf8'), 'original', 'the project file is untouched');
    assert.equal(readFileSync(join(scratch, 'src/linked.rs'), 'utf8'), 'fault');
    symlinkSync(outside, join(scratch, 'shared'));
    assert.throws(() => scratchWrite(scratch, join(scratch, 'shared/real.rs'), 'fault'), /leaves the scratch copy/);
    assert.equal(readFileSync(join(outside, 'real.rs'), 'utf8'), 'original');
  } finally { rmSync(outside, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test('targetOf maps test files to integration tests, libraries and programs', () => {
  const packages = [{ name: 'core', dir: 'crates/core', targets: [
    { name: 'core', kind: ['lib'], src: 'crates/core/src/lib.rs' },
    { name: 'tool', kind: ['bin'], src: 'crates/core/src/main.rs' },
    { name: 'extra', kind: ['bin'], src: 'crates/core/src/bin/extra/main.rs' },
    { name: 'secrets', kind: ['test'], src: 'crates/core/tests/secrets.rs' }] }];
  assert.deepEqual(targetOf('crates/core/tests/secrets.rs', packages).flags, ['--test', 'secrets']);
  assert.deepEqual(targetOf('crates/core/src/scan.rs', packages).flags, ['--lib']);
  assert.deepEqual(targetOf('crates/core/src/main.rs', packages).flags, ['--bin', 'tool']);
  assert.deepEqual(targetOf('crates/core/src/bin/extra/parse.rs', packages).flags, ['--bin', 'extra']);
  assert.equal(targetOf('other/tests/x.rs', packages), null);
  packages[0].targets.push({ name: 'it', kind: ['test'], src: 'crates/core/tests/it/main.rs' });
  assert.deepEqual(targetOf('crates/core/tests/it/storage.rs', packages).flags, ['--test', 'it'], 'a multi-file integration test');
});

function report(backend, extra = {}) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const project = realpathSync(mkdtempSync(join(repo, `.scratch/cargo-fast-${backend}-`)));
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, 'target'), { recursive: true, force: true });
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool, backend, ...extra } } } }));
  const env = { ...process.env, CARGO_TARGET_DIR: join(repo, `.scratch/cargo-fast-target-${backend}`) };
  const r = spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), 'report', '--runs', '1', '--out', 'out.json', '--json', '--no-reuse'],
    { cwd: project, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  try {
    assert.equal(r.status, 0, r.stderr);
    return { rows: JSON.parse(readFileSync(join(project, 'out.json'), 'utf8')).mutation.mutants.map(({ basis: _b, durationMs: _d, ...row }) => row), log: r.stderr };
  } finally { rmSync(project, { recursive: true, force: true }); }
}

function firstCatch() {
  const project = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-fast-first-')));
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, 'target'), { recursive: true, force: true });
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool, backend: 'cupel' } } } }));
  const env = { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-fast-target-first') };
  const cli = (...args) => spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), ...args], { cwd: project, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  try {
    const c = cli('report', '--runs', '1', '--no-mutation', '--out', 'collected.json', '--json');
    assert.equal(c.status, 0, c.stderr);
    const m = cli('mutate', '--input', 'collected.json', '--out', 'first.json', '--first-catch', '--no-reuse');
    assert.equal(m.status, 0, m.stderr);
    const doc = JSON.parse(readFileSync(join(project, 'first.json'), 'utf8'));
    assert.equal(doc.mutation.catches, 'first');
    return doc.mutation.mutants;
  } finally { rmSync(project, { recursive: true, force: true }); }
}

test('backend cupel gives the rows cargo-mutants gives, one build per fault and switched in one build', { skip, timeout: 900_000 }, () => {
  const reference = report('cargo-mutants');
  assert.ok(reference.rows.length >= 6);
  const single = report('cupel', { schemata: false });
  assert.deepEqual(single.rows, reference.rows);
  assert.match(single.log, /fault\(s\) with one build each/);
  const first = firstCatch();
  assert.deepEqual(first.map((r) => [r.id, r.status]), reference.rows.map((r) => [r.id, r.status]), 'first catch: same statuses');
  assert.ok(first.every((r) => !r.killedBy || r.killedBy.length <= reference.rows.find((x) => x.id === r.id).killedBy.length));
  const switched = report('cupel');
  assert.deepEqual(switched.rows, reference.rows);
  assert.match(switched.log, /fault\(s\) switched in one build/);
  assert.match(switched.log, /mutate-rust: timings first-build/);
  console.log(switched.log.split('\n').find((l) => l.includes('mutate-rust: timings')));
});

test('a second run in the same project reuses the build session: warm, baselines reused, same rows; a planted fault left in the session is restored', { skip, timeout: 900_000 }, () => {
  const reference = report('cargo-mutants');
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const project = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-fast-session-')));
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, 'target'), { recursive: true, force: true });
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool, backend: 'cupel' } } } }));
  const env = { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-fast-target-session') };
  const once = () => {
    const r = spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), 'report', '--runs', '1', '--out', 'out.json', '--json', '--no-reuse'],
      { cwd: project, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, r.stderr);
    return { rows: JSON.parse(readFileSync(join(project, 'out.json'), 'utf8')).mutation.mutants.map(({ basis: _b, durationMs: _d, ...row }) => row), timings: r.stderr.split('\n').find((l) => l.includes('mutate-rust: timings')) };
  };
  try {
    const cold = once();
    assert.match(cold.timings, /session cold, baselines reused 0\/\d+/);
    assert.deepEqual(cold.rows, reference.rows);
    const sessions = join(project, '.scratch/cupel-rust-sessions');
    const [id] = readdirSync(sessions);
    assert.ok(existsSync(join(sessions, id, 'target')) && existsSync(join(sessions, id, 'meta.json')));
    const warm = once();
    const m = /session warm, baselines reused (\d+)\/(\d+)/.exec(warm.timings);
    assert.ok(m && m[1] === m[2] && Number(m[1]) > 0, warm.timings);
    assert.deepEqual(warm.rows, cold.rows);
    console.log(`cold: ${cold.timings}\nwarm: ${warm.timings}`);

    // A crash that left a planted fault in the session copy: the next run restores it and its rows are unchanged.
    const planted = join(sessions, id, 'project/core/src/lib.rs');
    const original = readFileSync(planted, 'utf8');
    writeFileSync(planted, original.replace('n / 2', 'n * 2'));
    assert.notEqual(readFileSync(planted, 'utf8'), original);
    const healed = once();
    assert.equal(readFileSync(planted, 'utf8'), original);
    assert.deepEqual(healed.rows, cold.rows);
    assert.equal(readFileSync(join(fixture, 'core/src/lib.rs'), 'utf8'), original, 'the assessed project was not touched');
  } finally { rmSync(project, { recursive: true, force: true }); }
});
