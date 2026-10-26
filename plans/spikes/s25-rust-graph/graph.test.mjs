import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { baseEnv, run } from '../s20-compiled/process.mjs';
import { preflightGraph } from './preflight.mjs';

const fixture = resolve(import.meta.dirname, 'rust-fixture');
const files = ['src/lib.rs', 'src/outer.rs', 'src/outer/inner.rs'];
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceHashes = () => Object.fromEntries(files.map((name) => [name, hash(join(fixture, name))]));
const scratchBase = resolve('.scratch/s25-rust-graph');
const cargo = '/opt/homebrew/bin/cargo';

function temp() {
  mkdirSync(scratchBase, { recursive: true });
  return mkdtempSync(join(scratchBase, 'case-'));
}

function envFor(scratch, target) {
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  const cargoHome = join(scratch, 'cargo-home');
  mkdirSync(cargoHome, { recursive: true });
  return { ...baseEnv(home), PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
    CARGO_HOME: cargoHome, CARGO_TARGET_DIR: join(scratch, target), CARGO_NET_OFFLINE: 'true',
    CARGO_TERM_COLOR: 'never' };
}

function cargoTest(env, extra = []) {
  return run(cargo, ['test', '--offline', '--locked', '--manifest-path', join(fixture, 'Cargo.toml'),
    '--lib', ...extra], { cwd: fixture, env });
}

function metadata(output) {
  return output.split(/\r?\n/).filter((line) => /^(?:ROOT|OUTER|INNER)_META:/.test(line)).sort();
}

function graph(scratch) {
  const graphRoot = join(scratch, 'graph');
  mkdirSync(join(graphRoot, 'outer'), { recursive: true });
  const [root, outer, inner] = files.map((name) => join(fixture, name));
  const rootText = readFileSync(root, 'utf8');
  const outerText = readFileSync(outer, 'utf8');
  const innerText = readFileSync(inner, 'utf8');
  const oldRoot = 'mod outer;';
  const oldOuter = 'mod inner;';
  const oldInner = 'pub fn value() -> i32 { 1 }';
  for (const [text, old] of [[rootText, oldRoot], [outerText, oldOuter], [innerText, oldInner]])
    assert.equal(text.split(old).length, 2, `expected one ${old}`);
  writeFileSync(join(graphRoot, 'lib-mutant.rs'),
    rootText.replace(oldRoot, `#[path="${join(graphRoot, 'outer-mutant.rs')}"] mod outer;`));
  writeFileSync(join(graphRoot, 'outer-mutant.rs'),
    outerText.replace(oldOuter, `#[path="${join(graphRoot, 'outer/inner-mutant.rs')}"] mod inner;`));
  writeFileSync(join(graphRoot, 'outer/inner-mutant.rs'), innerText.replace(oldInner, 'pub fn value() -> i32 { 2 }'));
  symlinkSync(root, join(graphRoot, 'lib.rs'));
  symlinkSync(outer, join(graphRoot, 'outer.rs'));
  symlinkSync(inner, join(graphRoot, 'outer/inner.rs'));
  return graphRoot;
}

test('S25 non-root Cargo mutation preserves source and macro pins', (t) => {
  const before = sourceHashes();
  t.after(() => assert.deepEqual(sourceHashes(), before, 'original Rust sources changed'));
  preflightGraph(fixture);
  const scratch = temp();
  const env = envFor(scratch, 'baseline-target');
  const baseline = cargoTest(env);
  assert.equal(baseline.status, 0, baseline.output);
  assert.match(baseline.output, /2 passed/);
  assert.deepEqual(sourceHashes(), before);
  const baselinePins = cargoTest(env, ['source_and_macro_pins', '--', '--exact', '--nocapture']);
  assert.equal(baselinePins.status, 0, baselinePins.output);
  const originalMetadata = metadata(baselinePins.output);
  assert.equal(originalMetadata.length, 3, baselinePins.output);
  assert.deepEqual(sourceHashes(), before);

  const graphRoot = graph(scratch);
  assert.deepEqual(sourceHashes(), before);
  const wrapper = join(scratch, 'wrapper.mjs');
  copyFileSync(resolve(import.meta.dirname, 'wrapper.mjs'), wrapper);
  chmodSync(wrapper, 0o755);
  const log = join(scratch, 'compiler-input.jsonl');
  const mutantEnv = { ...envFor(scratch, 'mutant-target'), RUSTC_WRAPPER: wrapper,
    CUPEL_GRAPH_ROOT: fixture, CUPEL_GRAPH_SCRATCH: graphRoot, CUPEL_GRAPH_LOG: log };
  const behavior = cargoTest(mutantEnv, ['behavior', '--', '--exact', '--nocapture']);
  assert.notEqual(behavior.status, 0, behavior.output);
  assert.match(behavior.output, /left: 2/);
  assert.deepEqual(sourceHashes(), before);
  const pins = cargoTest(mutantEnv, ['source_and_macro_pins', '--', '--exact', '--nocapture']);
  assert.equal(pins.status, 0, pins.output);
  assert.deepEqual(metadata(pins.output), originalMetadata);
  const entries = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].crateRoot, 'src/lib.rs');
  assert.deepEqual(entries[0].remaps.map((row) => row[1]), files);
  assert.deepEqual(sourceHashes(), before);
});

test('S25 proof preflight refuses unmodeled Cargo source channels', () => {
  const controls = [
    ['build-script', (root) => writeFileSync(join(root, 'build.rs'), 'fn main() {}')],
    ['proc-macro', (root) => writeFileSync(join(root, 'Cargo.toml'), '[lib]\nproc-macro = true\n')],
    ['include-macro', (root) => writeFileSync(join(root, 'src/lib.rs'), 'include!("other.rs");\n')],
    ['path-attribute', (root) => writeFileSync(join(root, 'src/lib.rs'), '#[path="other.rs"] mod other;\n')],
    ['cfg', (root) => writeFileSync(join(root, 'src/lib.rs'), '#[cfg(feature="x")] mod other;\n')],
    ['generated-source', (root) => {
      mkdirSync(join(root, 'target'));
      writeFileSync(join(root, 'target/generated.rs'), 'pub fn generated() {}\n');
      symlinkSync(join(root, 'target/generated.rs'), join(root, 'src/generated.rs'));
    }],
  ];
  for (const [channel, modify] of controls) {
    const root = temp();
    mkdirSync(join(root, 'src'));
    copyFileSync(join(fixture, 'Cargo.toml'), join(root, 'Cargo.toml'));
    copyFileSync(join(fixture, 'src/lib.rs'), join(root, 'src/lib.rs'));
    modify(root);
    assert.throws(() => preflightGraph(root), { code: 'unsupported-rust-graph', channel });
  }
});
