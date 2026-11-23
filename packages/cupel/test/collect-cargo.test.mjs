import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNMEASURED, artifacts, collectCargo, definesFunctions, listedTests, llvmTools, programs, runnerRecords, selectsTargets, targetEnvironment, testResult, withVariables } from '../src/collect/cargo/index.mjs';
import { MARKER, runnerRecord } from '../src/collect/cargo/runner-shim.mjs';
import nodePath from 'node:path';
import { covered, exportLines, lineSet, combineRuns, inSourceScope, repoPath } from '../src/collect/cargo/coverage.mjs';
import { scanRust, shape } from '../src/collect/cargo/lex.mjs';
import { definitions, harnessName } from '../src/collect/cargo/tests.mjs';
import { matchesTestFile } from '../src/collect/cargo/test-globs.mjs';
import { match } from '../src/conformance/match.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';
import { requireCollector } from '../src/cli/collect.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repo, 'spec/conformance/adapters/cargo');
const bin = join(repo, 'packages/cupel/bin/cupel.mjs');
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const sample = JSON.parse(readFileSync(new URL('fixtures/cargo-llvm-export.json', import.meta.url), 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((name) => [name,
  JSON.parse(readFileSync(join(repo, `spec/schemas/${name}.schema.json`), 'utf8'))]));
const rust = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const llvmMajor = /^LLVM version: (\d+)/m.exec(rust.stdout)?.[1];
const component = rust.status === 0 ? spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).stdout.trim() : '';
const host = /^host: (.+)$/m.exec(rust.stdout)?.[1];
const componentDir = component && host ? join(component, 'lib', 'rustlib', host, 'bin') : '';
const pathDirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
const hasLlvm = !!llvmMajor && [componentDir, ...pathDirs].some((dir) => dir &&
  ['llvm-cov', 'llvm-profdata'].every((name) => {
    const result = spawnSync(join(dir, process.platform === 'win32' ? `${name}.exe` : name), ['--version'], { encoding: 'utf8' });
    return result.status === 0 && new RegExp(`\\bversion ${llvmMajor}\\.`).test(result.stdout);
  }));
const skipReason = !hasLlvm && `matching LLVM tools unavailable for rustc LLVM ${llvmMajor ?? 'unknown'}; run rustup component add llvm-tools-preview`;

test('LLVM export sample maps counted source characters and uncalled function', () => {
  const files = exportLines(sample, fixture);
  assert.deepEqual([...files.get('src/lib.rs').all].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
  assert.equal(covered(files)['src/lib.rs'], '1-3,9');
  assert.equal(lineSet(files.get('src/lib.rs').all), expected.sources['src/lib.rs'].coverable);
  const unstable = new Map();
  assert.deepEqual(combineRuns([{ 'src/lib.rs': '1-3' }, { 'src/lib.rs': '1-2,4' }], unstable), { 'src/lib.rs': '1-4' });
  assert.equal(lineSet(unstable.get('src/lib.rs')), '3-4');
});

test('Rust lexer, test ids, tags, shapes and text pins', () => {
  const lexed = scanRust('// comment\nlet x = r#"/* text */"#; /* outer /* inner */ done */\nlet y = \'a\'; let z = &\'life x;\n');
  assert.deepEqual([...lexed.codeLines], [2, 3]);
  assert.deepEqual(shape(scanRust('assert_eq!("one", 12);').tokens), shape(scanRust('assert_eq!("two", 33);').tokens));
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/cargo-static-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), 'mod group {\n// cupel:minor\n#[test]\nfn reads() { let x = include_str!("README.md"); assert!(x.contains("hi")); }\n}\n');
    const def = definitions(root)[0];
    assert.equal(def.id, 'src/lib.rs::group > reads');
    assert.deepEqual(def.tags, ['minor']);
    assert.deepEqual(def.brittleness, [{ test: def.id, kind: 'doc-wording', line: 3 }]);
    assert.ok(def.shape.length > 0);
    writeFileSync(join(root, 'src/tests.rs'), '#[test]\nfn reads() { assert!(true); }\n');
    const external = definitions(root).find((item) => item.file === 'src/tests.rs');
    assert.equal(harnessName(external, root, join(root, 'src/lib.rs')), 'tests::reads');
    assert.equal(harnessName(def, root, join(root, 'src/lib.rs')), 'group::reads');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Cargo artifact and harness parsing rejects missing results', () => {
  const message = { reason: 'compiler-artifact', profile: { test: true }, executable: '/tmp/test-bin', target: { src_path: '/tmp/lib.rs' } };
  assert.deepEqual(artifacts(`${JSON.stringify(message)}\n${JSON.stringify({ reason: 'build-finished' })}\n`), [{ binary: '/tmp/test-bin', root: '/tmp/lib.rs', manifest: undefined, name: undefined }]);
  assert.deepEqual(listedTests('a::b: test\nc: benchmark\n'), ['a::b']);
  assert.equal(testResult('test a::b ... ignored\n', 'a::b', 0), 'skipped');
  assert.equal(testResult('test a::b ... FAILED\n', 'a::b', 101), 'failed');
  assert.equal(testResult('', 'a::b', 134), 'failed');
  assert.throws(() => testResult('', 'a::b', 0), /without a harness result/);
  assert.equal(matchesTestFile('crates/{text,markdown,client}/**/*.rs', 'crates/text/src/tests.rs'), true);
  assert.equal(matchesTestFile('crates/{text,markdown,client}/**/*.rs', 'crates/audio/src/tests.rs'), false);
  assert.deepEqual(targetEnvironment('/a', {}), {});
  assert.notEqual(targetEnvironment('/a', { CARGO_TARGET_DIR: '/cache/target' }).CARGO_TARGET_DIR,
    targetEnvironment('/b', { CARGO_TARGET_DIR: '/cache/target' }).CARGO_TARGET_DIR);
  assert.match(targetEnvironment('/a', { CARGO_TARGET_DIR: '/cache/target' }).CARGO_TARGET_DIR, /^\/cache\/target\/cupel\//);
});

test('missing matching LLVM tools gives the exact installation remedy', { skip: rust.status !== 0 && 'rustc unavailable' }, async () => {
  const impossible = rust.stdout.replace(/^LLVM version: .+$/m, 'LLVM version: 999.0.0');
  await assert.rejects(llvmTools(fixture, process.env, impossible), /^Error: rustup component add llvm-tools-preview$/);
});

test('Cargo fixture matches hand-written expected input, schema, and report', { skip: skipReason }, async () => {
  const input = await collectCargo({ root: fixture, runs: 2, environment: { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-target-fixture') } });
  assert.deepEqual(match(expected, input), []);
  for (const file of ['src/lib.rs', 'tests/integration.rs']) assert.equal(input.sources[file].hash, `sha256:${createHash('sha256').update(readFileSync(join(fixture,file))).digest('hex')}`);
  assert.equal(input.sources['tests/integration.rs'].coverable, '');
  assert.deepEqual(validate(schemas.input, input), []);
  const { report, exit } = run('report', { input }, {}, {}, schemas);
  assert.equal(exit, 0, JSON.stringify(report.diagnostics));
  assert.deepEqual(report.diagnostics, []);
  assert.ok(input.tests.every((item) => item.durationsMs.length === 2));
  assert.deepEqual(input.coverage.unstable, {});
  assert.deepEqual(readdirSync(fixture).filter((name) => name.endsWith('.profraw')), []);
});

test('Cargo K13 unions per-test runs and marks changing branch lines', { skip: skipReason }, async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/cargo-k13-'));
  try {
    cpSync(fixture, root, { recursive: true, filter: (path) => !path.startsWith(join(fixture, 'target')) && !path.startsWith(join(fixture, '.scratch')) });
    writeFileSync(join(root, 'tests/integration.rs'), `use cupel_cargo_fixture::choose;
#[test]
fn alternating() {
    let marker = ".scratch/seen";
    let n = if std::path::Path::new(marker).exists() { 0 } else { -2 };
    std::fs::write(marker, "seen").unwrap();
    let expected = if n == 0 { 7 } else { 2 };
    assert_eq!(choose(n), expected);
}
`);
    const input = await collectCargo({ root, runs: 2, tests: 'tests/integration.rs', environment: { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-target-k13') } });
    assert.deepEqual(input.tests.map((item) => item.id), ['tests/integration.rs::alternating']);
    assert.equal(input.coverage.unstable['src/lib.rs'], '3-6');
    assert.equal(input.coverage.byTest['tests/integration.rs::alternating']['src/lib.rs'], '1-6,9');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Cargo CLI and configured external collector select Rust', { skip: skipReason }, async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/cargo-cli-'));
  try {
    cpSync(fixture, root, { recursive: true, filter: (path) => !path.startsWith(join(fixture, 'target')) && !path.startsWith(join(fixture, '.scratch')) });
    assert.equal(typeof (await requireCollector(process.env, root, { runners: { cargo: {} } })).collectNode, 'function');
    const env = { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_HOME: join(repo, '.scratch/cargo-home'), CARGO_TARGET_DIR: join(repo, '.scratch/cargo-target-cli'), TMPDIR: join(repo, '.scratch/tmp') };
    mkdirSync(env.CARGO_HOME, { recursive: true }); mkdirSync(env.CARGO_TARGET_DIR, { recursive: true }); mkdirSync(env.TMPDIR, { recursive: true });
    const direct = spawnSync(process.execPath, [bin, 'collect-cargo', '--root', root, '--runs', '1', '--out', join(root, '.scratch/direct.json')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.deepEqual(match(expected, JSON.parse(readFileSync(join(root, '.scratch/direct.json'), 'utf8'))), []);
    const selected = spawnSync(process.execPath, [bin, 'collect-cargo', '--root', root, '--runs', '1', '--out', join(root, '.scratch/selected.json'), '--', '--test', 'integration'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.scratch/selected.json'), 'utf8')).tests.map((item) => item.id), expected.tests.map((item) => item.id));
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { cargo: {} } }));
    const report = spawnSync(process.execPath, [bin, 'report', '--no-mutation', '--runs', '1', '--out', join(root, '.scratch/report.json'), '--json'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, '.scratch/report.json'), 'utf8')).runtime.name, 'rust');
    assert.equal(JSON.parse(report.stdout).kind, 'report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('should-panic and ignored harness lines, CRLF output and workspace programs', () => {
  assert.equal(testResult('test t::odd - should panic ... ok\n', 't::odd', 0), 'passed');
  assert.equal(testResult('test t::odd - should panic ... FAILED\r\n', 't::odd', 101), 'failed');
  assert.equal(testResult('test t::slow ... ignored, needs network\r\n', 't::slow', 0), 'skipped');
  assert.equal(testResult('test t::a ... ok\r\n', 't::a', 0), 'passed');
  const bin = { reason: 'compiler-artifact', profile: { test: false }, executable: '/t/ws-cli', target: { kind: ['bin'] } };
  const example = { reason: 'compiler-artifact', profile: { test: false }, executable: '/t/demo', target: { kind: ['example'] } };
  const harness = { reason: 'compiler-artifact', profile: { test: true }, executable: '/t/run-1', target: { kind: ['test'] } };
  assert.deepEqual(programs([bin, example, harness].map((m) => JSON.stringify(m)).join('\n')), ['/t/ws-cli']);
  assert.equal(selectsTargets(['--test', 'run']), true);
  assert.equal(selectsTargets(['--lib']), true);
  assert.equal(selectsTargets(['--features', 'x', '--release']), false);
});

test('runner records report only what Cargo added, and merge case-insensitively on Windows', () => {
  const base = { PATH: '/usr/bin', TOKEN: 'secret-value' };
  const digests = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex').slice(0, 16)]));
  const record = runnerRecord('/t/bin', '/w/core', { ...base, PATH: '/t/deps:/usr/bin', CARGO_MANIFEST_DIR: '/w/core', CUPEL_CARGO_BASE: JSON.stringify(digests) });
  assert.deepEqual(record, { binary: '/t/bin', cwd: '/w/core', added: { PATH: '/t/deps:/usr/bin', CARGO_MANIFEST_DIR: '/w/core' }, removed: [] });
  assert.equal(JSON.stringify(record).includes('secret-value'), false);
  const line = `noise\n${MARKER}${Buffer.from(JSON.stringify(record)).toString('base64')}\nmore`;
  assert.deepEqual(runnerRecords(line).get(nodePath.resolve('/t/bin')), record);
  assert.deepEqual(withVariables({ Path: 'C:\\a', HOME: 'h' }, { PATH: 'C:\\deps;C:\\a' }, [], 'win32'), { HOME: 'h', PATH: 'C:\\deps;C:\\a' });
  assert.deepEqual(withVariables({ Path: '/a', HOME: 'h' }, { PATH: '/b' }, ['HOME'], 'linux'), { Path: '/a', PATH: '/b' });
});

test('Windows export paths map to repository paths with / separators', () => {
  const win = nodePath.win32;
  assert.deepEqual(repoPath('C:\\work\\proj', 'C:\\work\\proj\\core\\src\\lib.rs', win), { abs: 'C:\\work\\proj\\core\\src\\lib.rs', path: 'core/src/lib.rs' });
  assert.equal(repoPath('C:\\work\\proj', 'D:\\other\\src\\lib.rs', win), null);
  assert.equal(repoPath('C:\\work\\proj', 'C:\\work\\elsewhere\\src\\lib.rs', win), null);
  assert.deepEqual(repoPath('/w/p', 'src/lib.rs', nodePath.posix), { abs: '/w/p/src/lib.rs', path: 'src/lib.rs' });
  assert.equal(inSourceScope('core/src/lib.rs'), true);
  assert.equal(inSourceScope('core/tests/run.rs'), false);
  assert.equal(inSourceScope('target/debug/build/x/src/lib.rs'), false);
});

test('functions with bodies decide whether an unseen file was measured', () => {
  assert.equal(definesFunctions('pub fn only_in_wasm() -> u8 {\n    7\n}\n'), true);
  assert.equal(definesFunctions('pub mod a;\npub struct S { f: fn(u8) -> u8 }\npub trait T { fn m(&self); }\n'), false);
  assert.equal(definesFunctions('// fn commented() {}\npub const X: u8 = 1;\n'), false);
});

test('test definitions accept attribute runs and async test macros', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/cargo-attrs-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), [
      '#[cfg(test)]', 'mod tests {',
      '    #[test]', '    #[should_panic(expected = "odd")]', '    fn odd() { panic!("odd"); }',
      '    // cupel:critical', '    #[ignore]', '    #[test]', '    fn slow() { assert!(1 + 1 == 2); }',
      '    #[tokio::test(flavor = "multi_thread")]', '    async fn later() { assert_eq!(1, 1); }',
      '    #[derive(Debug)]', '    struct NotATest;', '}', ''].join('\n'));
    const defs = definitions(root);
    assert.deepEqual(defs.map((d) => d.id), ['src/lib.rs::tests > odd', 'src/lib.rs::tests > slow', 'src/lib.rs::tests > later']);
    assert.deepEqual(defs[1].tags, ['critical']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Cargo workspace: package directory, should_panic, child programs, untested crates and unmeasured files', { skip: skipReason }, async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = realpathSync(mkdtempSync(join(repo, '.scratch/cargo-ws-')));
  try {
    cpSync(join(repo, 'spec/conformance/adapters/cargo-workspace'), root, { recursive: true });
    const input = await collectCargo({ root, runs: 1, environment: { ...process.env, CARGO_TARGET_DIR: join(repo, '.scratch/cargo-target-ws') } });
    assert.deepEqual(input.tests.map((t) => [t.id, t.status]), [
      ['cli/tests/run.rs::prints_secret', 'passed'],
      ['core/src/lib.rs::tests > even', 'passed'],
      ['core/src/lib.rs::tests > odd_panics', 'passed'],
      ['core/src/lib.rs::tests > reads_data_from_package_dir', 'passed'],
      ['core/src/lib.rs::tests > slow', 'skipped'],
      ['core/tests/secrets.rs::detects_key', 'passed'],
    ]);
    assert.equal(input.sources['core/src/secrets.rs'].coverable, '1-3');
    assert.equal(input.sources['glue/src/lib.rs'].coverable, '1-3');
    assert.equal(input.sources['cli/src/main.rs'].coverable, '1-8');
    assert.equal(input.sources['core/src/wasm_only.rs'].unmeasured, UNMEASURED);
    assert.equal(input.sources['core/src/wasm_only.rs'].coverable, '');
    assert.equal(input.sources['core/tests/secrets.rs'].unmeasured, undefined);
    assert.deepEqual(input.coverage.byTest['cli/tests/run.rs::prints_secret'], { 'cli/src/main.rs': '1-5,8', 'core/src/secrets.rs': '1-3' });
    assert.equal(input.coverage.byTest['core/src/lib.rs::tests > odd_panics']['core/src/lib.rs'], '5-7,18-20');
    assert.deepEqual(validate(schemas.input, input), []);
    const { report, exit } = run('report', { input }, {}, {}, schemas);
    assert.equal(exit, 0, JSON.stringify(report.diagnostics));
    const leftovers = [];
    const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === 'target' || e.name === '.scratch') continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.profraw')) leftovers.push(p); } };
    walk(root);
    assert.deepEqual(leftovers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
