import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { cli, gitBase, project, requireRuntime } from './native-cli-helpers.mjs';

const fixture = resolve(import.meta.dirname, 'fixtures/mutate-go');

test('Go CLI report, saved input and git guard use native mutation evidence', async (t) => {
  requireRuntime(t, 'go');
  const root = project(t, 'go');
  for (const file of ['go.mod', 'value.go', 'value_test.go']) copyFileSync(join(fixture, file), join(root, file));
  writeFileSync(join(root, 'cupel.json'), JSON.stringify({
    tiers: { critical: ['value.go'] }, mutation: { maxMutants: 10, maxSeconds: 120 },
  }));
  gitBase(root);

  const saved = join(root, 'input.json');
  const report = await cli(root, ['report', '--runs', '1', '--out', saved, '--json']);
  assert.ok(report.output.suite);
  const input = JSON.parse(readFileSync(saved, 'utf8'));
  assert.equal(input.runtime.name, 'go');
  assert.match(input.sources['value.go'].hash, /^sha256:[0-9a-f]{64}$/);
  const killed = input.mutation.mutants.find((row) => row.line === 3 && row.status === 'killed');
  assert.ok(killed);
  assert.deepEqual(killed.killedBy, ['value_test.go::TestChoose']);
  assert.equal(input.mutation.mutants.some((row) => row.killedBy?.includes('value_test.go::TestSourcePin')), false);

  const fromSaved = await cli(root, ['report', '--input', saved, '--json']);
  assert.equal(fromSaved.output.suite.units, report.output.suite.units);
  const noMutation = join(root, 'no-mutation.json');
  await cli(root, ['report', '--runs', '1', '--no-mutation', '--out', noMutation, '--json']);
  assert.equal(JSON.parse(readFileSync(noMutation, 'utf8')).mutation, undefined);

  const testFile = join(root, 'value_test.go');
  const before = readFileSync(testFile, 'utf8');
  const weakened = before.replace('t.Fatalf("Choose(2) = %d, want 3", got)', 't.Logf("Choose(2) = %d, want 3", got)');
  assert.notEqual(weakened, before);
  writeFileSync(testFile, weakened);
  const guarded = await cli(root, ['guard', '--base', 'HEAD', '--runs', '1', '--json'], 1);
  const lost = guarded.output.guard.checks.find((row) => row.id === 'critical-mutation');
  assert.deepEqual(lost.lost, { mutants: [killed.id] });
});
