import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifacts, collectCargo, listedTests, llvmTools, targetEnvironment, testResult } from '../src/collect/cargo/index.mjs';
import { covered, exportLines, lineSet, combineRuns } from '../src/collect/cargo/coverage.mjs';
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
const hasLlvm = !!llvmMajor && [componentDir, '/opt/homebrew/opt/llvm/bin'].some((dir) => dir &&
  ['llvm-cov', 'llvm-profdata'].every((name) => {
    const result = spawnSync(join(dir, name), ['--version'], { encoding: 'utf8' });
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
