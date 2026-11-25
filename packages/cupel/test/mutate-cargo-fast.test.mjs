// Cupel's own Rust runner (backend "cupel", D21) gives the same rows as cargo-mutants on the fixture workspace,
// with and without switchable faults, and leaves the project unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog } from '../src/mutate-cargo/logs.mjs';
import { applyMutant, listFaults, missingResults, renderFaults, regroups, scratchWrite, shiftSpan, switchable, targetOf } from '../src/mutate-cargo/fast.mjs';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as schemata from '../src/mutate-cargo/schemata.mjs';
import * as bodies from '../src/mutate-cargo/schemata-body.mjs';
import { mutantId } from '../src/mutate-cargo/import.mjs';
import { slicePlan } from '../src/mutate-cargo/run.mjs';

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

test('regrouping faults go to body variants; the unary-minus case and same-level swaps do not', () => {
  const text = 'fn f(a: bool, b: bool, x: i32) -> bool {\n  a && b || x == -1 + 2\n}\n';
  const at = (genre, col, len, replacement) => ({ genre, replacement, span: { start: { line: 2, column: col }, end: { line: 2, column: col + len } } });
  assert.equal(regroups(text, at('BinaryOperator', 5, 2, '||')), true);
  assert.equal(regroups(text, at('BinaryOperator', 10, 2, '&&')), true);
  assert.equal(regroups(text, at('BinaryOperator', 15, 2, '!=')), false, 'same level: plain switch');
  assert.equal(regroups(text, at('UnaryOperator', 18, 1, '')), false);
});

test('shiftSpan moves only positions at or after an insertion on their own line', () => {
  const span = { start: { line: 3, column: 10 }, end: { line: 3, column: 12 } };
  assert.deepEqual(shiftSpan(span, [{ line: 3, column: 20, length: 7 }]), span);
  assert.deepEqual(shiftSpan(span, [{ line: 2, column: 1, length: 7 }]), span);
  assert.deepEqual(shiftSpan(span, [{ line: 3, column: 4, length: 7 }, { line: 3, column: 9, length: 2 }]),
    { start: { line: 3, column: 19 }, end: { line: 3, column: 21 } });
});

const SOURCES = {
  'src/a.rs': 'pub fn f(a: i32, b: i32) -> bool {\n    a + b == 3 && a < b\n}\npub fn g(x: bool, y: bool, z: bool) -> bool {\n    x && y || z\n}\n',
  'src/b.rs': 'pub fn h(a: i32, b: i32) -> bool {\n    a - b != 1 && b > a\n}\n',
};
const entry = (file, needle, replacement, name) => {
  const text = SOURCES[file];
  const at = text.indexOf(needle, text.indexOf('{', text.indexOf(`fn ${name}(`)));
  const pos = (offset) => { const line = text.slice(0, offset).split('\n').length; return { line, column: offset - text.lastIndexOf('\n', offset - 1) }; };
  return { file, genre: 'BinaryOperator', name: `${file}:${pos(at).line}:${pos(at).column}: replace ${needle} with ${replacement}`, replacement,
    span: { start: pos(at), end: pos(at + needle.length) }, function: { function_name: name }, package: 'p' };
};

test('numbers and rendered text cover the whole scope: every slice of a plan gets the same selectors and the same switched sources', () => {
  const listing = [entry('src/a.rs', '==', '!=', 'f'), entry('src/a.rs', '&&', '||', 'f'), entry('src/a.rs', '<', '>', 'f'), entry('src/a.rs', '&&', '||', 'g'),
    entry('src/b.rs', '!=', '==', 'h'), entry('src/b.rs', '&&', '||', 'h'), entry('src/b.rs', '>', '<', 'h')];
  const wanted = new Map([['src/a.rs', new Set([2, 5])], ['src/b.rs', new Set([2])]]); // the whole scope: both files
  const render = (run) => {
    // What a slice does: numbers and files come from the scope (`wanted`), whatever `run` holds.
    const { numbers, listed } = listFaults(listing, wanted.keys());
    assert.ok(run.every((id) => numbers.has(id)));
    const texts = {};
    for (const [file, list] of listed) texts[file] = renderFaults({ text: SOURCES[file], list, schemata, bodies });
    return { numbers: [...numbers].sort(), texts, selectors: run.map((id) => [id, numbers.get(id)]).sort() };
  };
  const ids = listing.map(mutantId);
  const full = render(ids);
  const slices = [ids.slice(4), ids.slice(0, 2), [ids[5]], [ids[3], ids[6]]];
  for (const run of slices) {
    const r = render(run);
    assert.deepEqual(r.numbers, full.numbers);
    assert.deepEqual(r.texts, full.texts);
    assert.deepEqual(r.selectors, full.selectors.filter(([id]) => run.includes(id)));
  }
  // A slice holding only b.rs does not number from 1, and b.rs is rendered although none of its faults is in a.rs's slice.
  const { numbers } = listFaults(listing, wanted.keys());
  assert.equal(numbers.get(mutantId(listing[4])), 5);
  assert.equal(stableOnly(listing).get(mutantId(listing[4])), 1, 'the old way (files of the slice) would give 1');
  assert.ok(full.texts['src/a.rs'].text.includes('__cupel_faults'), 'switched');
  assert.ok(full.texts['src/a.rs'].bodies.length > 0 && full.texts['src/b.rs'].bodies.length > 0, 'regrouping faults are body variants in both files');
  // Slicing a real plan keeps the others out of `run` only.
  const sliced = slicePlan({ noCoverage: [], reused: [], run: ids.map((id) => ({ id })), candidates: [], chosen: [] }, [ids[4]]);
  assert.deepEqual(sliced.run.map((c) => c.id), [ids[4]]);
});

function stableOnly(listing) { return listFaults(listing, ['src/b.rs']).numbers; }

test('a project that reads panic locations gets no body variants from the renderer', () => {
  const listing = [entry('src/a.rs', '&&', '||', 'g')];
  const { listed } = listFaults(listing, ['src/a.rs']);
  const text = SOURCES['src/a.rs'];
  const on = renderFaults({ text, list: listed.get('src/a.rs'), schemata, bodies });
  const off = renderFaults({ text, list: listed.get('src/a.rs'), schemata, bodies, locations: true });
  assert.ok(on.bodies.length > 0);
  assert.deepEqual(off.bodies, []);
  assert.ok(off.refusedBodies.every((r) => r.reason === 'location'));
  assert.ok(!off.text.includes('match crate::__cupel_faults::active()'));
});

function report(backend, extra = {}, extraEnv = {}) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const project = realpathSync(mkdtempSync(join(repo, `.scratch/cargo-fast-${backend}-`)));
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, 'target'), { recursive: true, force: true });
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool, backend, ...extra } } } }));
  const env = { ...process.env, CARGO_TARGET_DIR: join(repo, `.scratch/cargo-fast-target-${backend}`), CUPEL_CACHE_DIR: realpathSync(mkdtempSync(join(tmpdir(), 'cupel-cache-'))), ...extraEnv };
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
  const env = { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-fast-target-first'), CUPEL_CACHE_DIR: realpathSync(mkdtempSync(join(tmpdir(), 'cupel-cache-'))) };
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
  const noBodies = report('cupel');
  assert.deepEqual(noBodies.rows, reference.rows);
  assert.match(noBodies.log.split('\n').find((l) => l.includes('mutate-rust: timings')), /switched \d+ \(operators \d+, bodies 0\)/, 'body variants are opt-in');
  const switched = report('cupel', { bodyVariants: true });
  assert.deepEqual(switched.rows, reference.rows);
  assert.match(switched.log, /fault\(s\) switched in one build/);
  assert.match(switched.log, /mutate-rust: timings first-build/);
  const line = switched.log.split('\n').find((l) => l.includes('mutate-rust: timings'));
  console.log(line);
  assert.match(line, /switched \d+ \(operators \d+, bodies [1-9]\d*\), individual \d+/, 'the regrouping && fault is answered by a body variant');
  const verified = report('cupel', { bodyVariants: true }, { CUPEL_RUST_VERIFY_SWITCHED: '1' });
  assert.deepEqual(verified.rows, reference.rows);
  assert.match(verified.log, /mutate-rust: verified \d+ switched fault\(s\) against individual builds: all agree/);
  const count = /mutate-rust: verified (\d+) switched fault/.exec(verified.log)[1];
  assert.equal(count, /switched (\d+) \(operators/.exec(verified.log.split('\n').find((l) => l.includes('mutate-rust: timings')))[1], 'every fault that used the switched build is verified');
});

test('a second run in the same project reuses the build session: warm, baselines reused, same rows; a planted fault left in the session is restored', { skip, timeout: 900_000 }, () => {
  const reference = report('cargo-mutants');
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const project = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-fast-session-')));
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, 'target'), { recursive: true, force: true });
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool, backend: 'cupel', sessionEnvIgnore: ['REUSE_IGNORED_*'] } } } }));
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-cache-')));
  const env = { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-fast-target-session'), CUPEL_CACHE_DIR: cache };
  const once = () => {
    const r = spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), 'report', '--runs', '1', '--out', 'out.json', '--json', '--no-reuse'],
      { cwd: project, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(readFileSync(join(project, 'out.json'), 'utf8')).mutation.mutants.map(({ basis: _b, durationMs: _d, ...row }) => row);
    // The report files are part of the project the next run copies; reuse needs the project unchanged, so they go.
    for (const name of ['out.json', 'skipped.json']) rmSync(join(project, name), { force: true });
    return { rows, timings: r.stderr.split('\n').find((l) => l.includes('mutate-rust: timings')) };
  };
  try {
    const cold = once();
    assert.match(cold.timings, /session cold, prepared false, baselines reused 0\/\d+/);
    assert.deepEqual(cold.rows, reference.rows);
    const sessions = join(cache, 'rust-sessions');
    assert.equal(existsSync(join(project, '.scratch/cupel-rust-sessions')), false, 'nothing is kept in the project');
    const [id] = readdirSync(sessions);
    assert.ok(existsSync(join(sessions, id, 'target')) && existsSync(join(sessions, id, 'meta.json')));
    const warm = once();
    const m = /session warm, prepared false, baselines reused (\d+)\/(\d+)/.exec(warm.timings);
    assert.ok(m && m[1] === m[2] && Number(m[1]) > 0, warm.timings);
    assert.deepEqual(warm.rows, cold.rows);
    const off = /switches-off reused (\d+)\/(\d+)/.exec(warm.timings);
    assert.ok(off && off[1] === off[2] && Number(off[1]) > 0, `switches-off verdict reused: ${warm.timings}`);
    console.log(`cold: ${cold.timings}\nwarm: ${warm.timings}`);

    // Anything else that can change a test's outcome must stop reuse: a test environment variable, and a data file of the
    // same size (the test executables stay the same).
    env.REUSE_PROBE = '1';
    const withEnv = once();
    assert.match(withEnv.timings, /baselines reused 0\/\d+/, withEnv.timings);
    assert.match(withEnv.timings, /switches-off reused 0\/\d+/, withEnv.timings);
    delete env.REUSE_PROBE;
    // Cupel's own variables and the ones sessionEnvIgnore names do not count (the passes above were measured again with
    // REUSE_PROBE set, so first a run that records them without it).
    once();
    env.CUPEL_REUSE_PROBE = '1'; env.REUSE_IGNORED_JOB = '7';
    const ignored = once();
    assert.match(ignored.timings, /baselines reused (\d+)\/\1, switches-off reused (\d+)\/\2/, ignored.timings);
    delete env.CUPEL_REUSE_PROBE; delete env.REUSE_IGNORED_JOB;
    const data = join(project, 'core/data/greeting.txt');
    const kept = readFileSync(data, 'utf8');
    writeFileSync(data, kept.replace('hello', 'jello'));
    const withData = once();
    assert.match(withData.timings, /baselines reused 0\/\d+/, withData.timings);
    assert.match(withData.timings, /switches-off reused 0\/\d+/, withData.timings);
    writeFileSync(data, kept);
    once(); // measured again for the original content
    const again = once();
    assert.match(again.timings, /baselines reused (\d+)\/\1/, again.timings);
    assert.deepEqual(again.rows, cold.rows);

    // A crash that left a planted fault in the session copy: the next run restores it and its rows are unchanged.
    const planted = join(sessions, id, 'project/core/src/lib.rs');
    const original = readFileSync(planted, 'utf8');
    writeFileSync(planted, original.replace('n / 2', 'n * 2'));
    assert.notEqual(readFileSync(planted, 'utf8'), original);
    const healed = once();
    assert.equal(readFileSync(planted, 'utf8'), original);
    assert.deepEqual(healed.rows, cold.rows);
    assert.equal(readFileSync(join(fixture, 'core/src/lib.rs'), 'utf8'), original, 'the assessed project was not touched');
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); }
});

test('a prepared Rust session is shared by two slices and merges to the whole run', { skip, timeout: 900_000 }, () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const project = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-fast-bundle-')));
  const wholeCache = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-whole-cache-')));
  const bundleCache = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-bundle-cache-')));
  cpSync(fixture, project, { recursive: true });
  rmSync(join(project, 'target'), { recursive: true, force: true });
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { cargo: { mutants: { command: tool, backend: 'cupel' } } } }));
  const cliWithEnv = (extraEnv, ...args) => spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), ...args],
    { cwd: project, env: { ...process.env, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 << 20 });
  const cli = (...args) => cliWithEnv({}, ...args);
  const ok = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stderr); return r; };
  try {
    ok('report', '--runs', '1', '--no-mutation', '--out', '.cupel/collected.json', '--json');
    ok('mutate', '--input', '.cupel/collected.json', '--runner', 'cargo', '--out', '.cupel/whole.json', '--cache-dir', wholeCache, '--no-reuse');
    const prepared = ok('mutate', '--input', '.cupel/collected.json', '--runner', 'cargo', '--prepare', '--cache-dir', bundleCache, '--json', '--no-reuse');
    const info = JSON.parse(prepared.stdout);
    assert.equal(info.cacheDir, bundleCache);
    assert.equal(info.sessionDir, join(bundleCache, 'rust-sessions', info.sessionId));
    assert.match(prepared.stderr, new RegExp(`prepared Rust build session ${info.sessionId}`));
    const slices = [1, 2].map((index) => {
      const timings = join(project, `.cupel/timings-${index}.json`);
      const r = cliWithEnv({ CUPEL_RUST_TIMINGS: timings }, 'mutate', '--input', '.cupel/collected.json', '--runner', 'cargo', '--shard', `${index}/2`,
        '--out', `.cupel/slice-${index}.json`, '--cache-dir', bundleCache, '--no-reuse');
      assert.equal(r.status, 0, r.stderr);
      return { result: r, timings: JSON.parse(readFileSync(timings, 'utf8')) };
    });
    for (const { result: slice, timings } of slices) {
      const line = slice.stderr.split('\n').find((x) => x.includes('mutate-rust: timings'));
      assert.match(line, /session warm, prepared true, baselines reused (\d+)\/\1, switches-off reused (\d+)\/\2/);
      assert.equal(timings.prepared, true);
      assert.equal(timings.baselinesReused, timings.baselinesTotal);
      assert.equal(timings.switchesOffReused, timings.switchesOffTotal);
    }
    ok('merge-mutations', '--input', '.cupel/collected.json', '--out', '.cupel/merged.json', '.cupel/slice-1.json', '.cupel/slice-2.json');
    const rows = (name) => JSON.parse(readFileSync(join(project, `.cupel/${name}.json`), 'utf8')).mutation.mutants.map(({ basis: _basis, durationMs: _duration, ...row }) => row);
    assert.deepEqual(rows('merged'), rows('whole'));
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(wholeCache, { recursive: true, force: true });
    rmSync(bundleCache, { recursive: true, force: true });
  }
});
