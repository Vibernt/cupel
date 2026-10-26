import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function goPackageSmoke({ root, scratch, bin, checked }) {
  const probe = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || !/\bgo1\.27\.1\b/.test(probe.stdout)) {
    const reason = 'installed Go smoke needs Go 1.27.1';
    if (process.env.CUPEL_REQUIRE_GO_SMOKE === '1') assert.fail(reason);
    return { skipped: reason };
  }

  const project = join(scratch, 'installed-go-project');
  mkdirSync(project, { recursive: true });
  const fixture = join(root, 'packages/cupel/test/fixtures/mutate-go');
  for (const file of ['go.mod', 'value.go', 'value_test.go']) copyFileSync(join(fixture, file), join(project, file));
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ tiers: { critical: ['value.go'] },
    mutation: { maxMutants: 10, maxSeconds: 120 } }));

  const basePath = join(project, 'base-input.json');
  checked(bin, ['report', '--runs', '1', '--out', basePath, '--json'], { cwd: project });
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const killed = base.mutation?.mutants.filter((row) => row.status === 'killed') ?? [];
  assert.ok(killed.length, 'installed Go mutation produced no killed mutant');
  assert.equal(killed.some((row) => row.killedBy?.includes('value_test.go::TestSourcePin')), false);

  const testFile = join(project, 'value_test.go');
  writeFileSync(testFile, readFileSync(testFile, 'utf8').replace(
    't.Fatalf("Choose(2) = %d, want 3", got)', 't.Logf("Choose(2) = %d, want 3", got)'));
  const headPath = join(project, 'head-input.json');
  checked(bin, ['report', '--runs', '1', '--out', headPath, '--json'], { cwd: project });
  const guarded = spawnSync(bin, ['guard', '--base-input', basePath, '--head-input', headPath, '--json'], {
    cwd: project, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(guarded.error);
  assert.equal(guarded.status, 1, `${guarded.stderr}\n${guarded.stdout}`);
  const loss = JSON.parse(guarded.stdout).guard.checks.find((row) => row.id === 'critical-mutation');
  assert.ok(loss.lost.mutants.some((id) => killed.some((row) => row.id === id)), JSON.stringify(loss));
  return { runtime: probe.stdout.trim(), killed: killed.length, lost: loss.lost.mutants.length };
}
