import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { baseEnv, run, sha256 } from './process.mjs';

const fixture = resolve(import.meta.dirname, 'rust-fixture');
const source = join(fixture, 'src/lib.rs');

function assertCase(binary, name, expectedStatus, phrase, env) {
  const result = run(binary, ['--exact', name, '--nocapture'], { cwd: fixture, env });
  assert.equal(result.status === 0, expectedStatus === 0, result.output);
  if (phrase) assert.match(result.output, phrase);
}

test('Rust root relocation needs pristine links and file path remap', (t) => {
  const before = sha256(source);
  t.after(() => assert.equal(sha256(source), before, 'original Rust source changed'));

  mkdirSync(resolve('.scratch/s20-compiled'), { recursive: true });
  const scratch = mkdtempSync(resolve('.scratch/s20-compiled', 'rust-'));
  const home = join(scratch, 'home');
  mkdirSync(home);
  const env = {
    ...baseEnv(home), CARGO_NET_OFFLINE: 'true', CARGO_HOME: join(scratch, 'cargo-home'),
    CARGO_TARGET_DIR: join(scratch, 'target'), CARGO_MANIFEST_DIR: fixture,
  };

  const baseline = run('/opt/homebrew/bin/cargo', ['test', '--offline', '--quiet', '--manifest-path', join(fixture, 'Cargo.toml')], { cwd: fixture, env });
  assert.equal(baseline.status, 0, baseline.output);

  const same = join(scratch, 'same-name');
  mkdirSync(same);
  const sameSource = join(same, 'lib.rs');
  const mutantText = readFileSync(source, 'utf8').replace('fn value() -> i32 { 1 }', 'fn value() -> i32 { 2 }');
  writeFileSync(sameSource, mutantText);
  const sameBinary = join(same, 'tests');
  const compiled = run('/opt/homebrew/bin/rustc', ['--test', sameSource, '-o', sameBinary], { cwd: fixture, env });
  assert.equal(compiled.status, 0, compiled.output);
  assertCase(sameBinary, 'behavior', 1, /left: 2/, env);
  assertCase(sameBinary, 'runtime_source_pin', 0, null, env);
  assertCase(sameBinary, 'include_relative_pin', 1, /left: Some\("fn value\(\) -> i32 \{ 2 \}"\)/, env);
  assertCase(sameBinary, 'include_manifest_pin', 0, null, env);
  assertCase(sameBinary, 'include_bytes_pin', 1, /assertion failed/, env);
  assertCase(sameBinary, 'source_path_macro', 1, /assertion failed/, env);

  const renamed = join(scratch, 'renamed');
  mkdirSync(renamed);
  const renamedSource = join(renamed, 'mutant.rs');
  writeFileSync(renamedSource, mutantText);
  symlinkSync(source, join(renamed, 'lib.rs'));
  const renamedBinary = join(renamed, 'tests');
  const compiledRenamed = run('/opt/homebrew/bin/rustc', ['--test', renamedSource, '-o', renamedBinary], { cwd: fixture, env });
  assert.equal(compiledRenamed.status, 0, compiledRenamed.output);
  assertCase(renamedBinary, 'behavior', 1, /left: 2/, env);
  assertCase(renamedBinary, 'runtime_source_pin', 0, null, env);
  assertCase(renamedBinary, 'include_relative_pin', 0, null, env);
  assertCase(renamedBinary, 'include_manifest_pin', 0, null, env);
  assertCase(renamedBinary, 'include_bytes_pin', 0, null, env);
  assertCase(renamedBinary, 'source_path_macro', 1, /assertion failed/, env);

  const remappedBinary = join(renamed, 'remapped-tests');
  const remapped = run('/opt/homebrew/bin/rustc', [
    '--test', renamedSource,
    `--remap-path-prefix=${renamedSource}=${source}`,
    '-o', remappedBinary,
  ], { cwd: fixture, env });
  assert.equal(remapped.status, 0, remapped.output);
  assertCase(remappedBinary, 'behavior', 1, /left: 2/, env);
  for (const name of ['runtime_source_pin', 'include_relative_pin', 'include_manifest_pin', 'include_bytes_pin', 'source_path_macro']) {
    assertCase(remappedBinary, name, 0, null, env);
  }

  const wrapper = join(scratch, 'rust-wrapper.mjs');
  copyFileSync(resolve(import.meta.dirname, 'rust-wrapper.mjs'), wrapper);
  chmodSync(wrapper, 0o755);
  const cargoEnv = {
    ...env,
    CARGO_TARGET_DIR: join(scratch, 'mutant-target'),
    RUSTC_WRAPPER: wrapper,
    CUPEL_PROOF_SOURCE: source,
    CUPEL_PROOF_MUTANT: renamedSource,
  };
  const cargoArgs = ['test', '--offline', '--quiet', '--manifest-path', join(fixture, 'Cargo.toml')];
  const cargoBehavior = run('/opt/homebrew/bin/cargo', [...cargoArgs, 'behavior', '--', '--exact'], { cwd: fixture, env: cargoEnv });
  assert.notEqual(cargoBehavior.status, 0, cargoBehavior.output);
  assert.match(cargoBehavior.output, /left: 2/);
  const cargoPins = run('/opt/homebrew/bin/cargo', [...cargoArgs, '--', '--skip', 'behavior'], { cwd: fixture, env: cargoEnv });
  assert.equal(cargoPins.status, 0, cargoPins.output);
  assert.match(cargoPins.output, /5 passed/);
});
