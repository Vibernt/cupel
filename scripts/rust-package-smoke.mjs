import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function rustPackageSmoke({ root, scratch, bin, checked }) {
  const project = join(scratch, 'installed-rust-project');
  const fixture = join(root, 'packages/cupel/test/fixtures/rust-mutation');
  for (const file of ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/outer.rs', 'src/outer/inner.rs']) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    copyFileSync(join(fixture, file), join(project, file));
  }
  const production = join(project, 'src/outer/inner.rs');
  writeFileSync(production, readFileSync(production, 'utf8').replace(
    'pub fn value() -> i32 { 1 }', 'pub fn value() -> i32 { 0 + 1 }'));
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({
    tiers: { critical: ['src/outer/inner.rs'] }, mutation: { maxMutants: 10, maxSeconds: 120 },
  }));
  const basePath = join(project, 'base-input.json');
  checked(process.execPath, [bin, 'report', '--runs', '1', '--out', basePath, '--json'], { cwd: project });
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const killed = base.mutation?.mutants.filter(row => row.status === 'killed') ?? [];
  assert.equal(killed.length, 1, JSON.stringify(base.mutation));
  assert.deepEqual(killed[0].killedBy, ['src/lib.rs::behavior']);
  assert.equal(base.mutation.mutants.some(row => row.killedBy?.includes('src/lib.rs::source_and_macro_pins')), false);
  const testPath = join(project, 'src/lib.rs');
  writeFileSync(testPath, readFileSync(testPath, 'utf8').replace(
    'assert_eq!(outer::value(), 1);', 'let value = outer::value();'));
  const headPath = join(project, 'head-input.json');
  checked(process.execPath, [bin, 'report', '--runs', '1', '--out', headPath, '--json'], { cwd: project });
  const guarded = spawnSync(process.execPath, [bin, 'guard', '--base-input', basePath,
    '--head-input', headPath, '--json'], { cwd: project, encoding: 'utf8',
    timeout: 120_000, maxBuffer: 16 << 20 });
  assert.ifError(guarded.error);
  assert.equal(guarded.status, 1, `${guarded.stderr}\n${guarded.stdout}`);
  const loss = JSON.parse(guarded.stdout).guard.checks.find(row => row.id === 'critical-mutation');
  assert.deepEqual(loss.lost.mutants, killed.map(row => row.id));
  return { runtime: base.runtime, killed: killed.length, lost: loss.lost.mutants.length };
}
