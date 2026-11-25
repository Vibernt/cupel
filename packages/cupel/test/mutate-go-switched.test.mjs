import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { collectGo } from '../src/collect/go/index.mjs';
import { mutateGo } from '../src/mutate-go/index.mjs';
import { goPackageSwitchReason } from '../src/mutate-go/switched.mjs';

const fixture = resolve(import.meta.dirname, 'fixtures/mutate-go');
const scratch = resolve('.scratch', 'mutate-go-switched-tests');
const config = (schemata = true) => ({
  mutation: { maxMutants: 10, maxSeconds: 120, seed: 7 },
  runners: { go: { mutants: { schemata } } },
});

function hasVerifiedGo(t) {
  const result = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (!result.error && result.status === 0 && /\bgo1\.27\.1\b/.test(result.stdout)) return true;
  const message = 'go switched mutation needs Go 1.27.1';
  if (process.env.CUPEL_REQUIRE_NATIVE_MUTATION === '1') assert.fail(message);
  t.skip(message);
  return false;
}

function project(t, source, tests) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-'));
  copyFileSync(join(fixture, 'go.mod'), join(root, 'go.mod'));
  writeFileSync(join(root, 'value.go'), source);
  writeFileSync(join(root, 'value_test.go'), tests);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const cleanSource = `package fixture

func Choose(n int) int { return n + 1 }

func Identity(n int) int { return n + 0 }
`;
const cleanTests = `package fixture

import "testing"

func TestChoose(t *testing.T) { if Choose(2) != 3 { t.Fatal("Choose") } }
func TestIdentity(t *testing.T) { if Identity(2) != 2 { t.Fatal("Identity") } }
`;

test('Go switched build matches individual rows with fewer compile commands', { timeout: 120_000 }, async (t) => {
  if (!hasVerifiedGo(t)) return;
  const root = project(t, cleanSource, cleanTests);
  const input = await collectGo({ root, runs: 1 });
  const scope = { changed: { 'value.go': '3,5' }, targeted: ['value_test.go::TestChoose', 'value_test.go::TestIdentity'] };

  const individualMetrics = {};
  const individualStarted = performance.now();
  const individual = await mutateGo({ root, input, scope, config: config(false), metrics: individualMetrics });
  const individualMs = Math.round(performance.now() - individualStarted);

  const switchedMetrics = {};
  const logs = [];
  const timingsPath = join(root, '.scratch', 'go-timings.json');
  const previousTimings = process.env.CUPEL_GO_TIMINGS;
  process.env.CUPEL_GO_TIMINGS = timingsPath;
  const switchedStarted = performance.now();
  let switched;
  try {
    switched = await mutateGo({ root, input, scope, config: config(true), metrics: switchedMetrics, log: (line) => logs.push(line) });
  } finally {
    if (previousTimings === undefined) delete process.env.CUPEL_GO_TIMINGS;
    else process.env.CUPEL_GO_TIMINGS = previousTimings;
  }
  const switchedMs = Math.round(performance.now() - switchedStarted);

  assert.deepEqual(switched, individual);
  assert.equal(switchedMetrics.switched, 2);
  assert.equal(switchedMetrics.individual, 0);
  assert.ok(switchedMetrics.compileCalls < individualMetrics.compileCalls,
    `switched used ${switchedMetrics.compileCalls} go test -c calls; individual used ${individualMetrics.compileCalls}`);
  assert.match(logs.find((line) => line.startsWith('mutate-go: timings ')) ?? '', /switched 2, individual 0, compile .* test .* go \d+ call/);
  const timings = JSON.parse(readFileSync(timingsPath, 'utf8'));
  assert.equal(timings.switched, 2);
  assert.equal(timings.compileCalls, switchedMetrics.compileCalls);
  t.diagnostic(`fixture wall time: individual ${individualMs}ms; switched ${switchedMs}ms; go test -c ${individualMetrics.compileCalls} -> ${switchedMetrics.compileCalls}`);
});

test('Go switched verification agrees with an individual build and credited test', { timeout: 120_000 }, async (t) => {
  if (!hasVerifiedGo(t)) return;
  const root = project(t, cleanSource, cleanTests);
  const input = await collectGo({ root, runs: 1 });
  const previous = process.env.CUPEL_GO_VERIFY_SWITCHED;
  process.env.CUPEL_GO_VERIFY_SWITCHED = '1';
  try {
    const metrics = {};
    const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '3' } }, config: config(true), metrics });
    assert.equal(mutation.mutants[0].status, 'killed');
    assert.deepEqual(mutation.mutants[0].killedBy, ['value_test.go::TestChoose']);
    assert.equal(metrics.verified, 1);
  } finally {
    if (previous === undefined) delete process.env.CUPEL_GO_VERIFY_SWITCHED;
    else process.env.CUPEL_GO_VERIFY_SWITCHED = previous;
  }
});

test('Go renderer refusal runs the fault on an individual build', { timeout: 120_000 }, async (t) => {
  if (!hasVerifiedGo(t)) return;
  const source = 'package fixture\n\nfunc Choose(n int) int {\nagain:\n\tif n < 0 { goto again }\n\treturn n + 1\n}\n';
  const tests = 'package fixture\n\nimport "testing"\nfunc TestChoose(t *testing.T) { if Choose(2) != 3 { t.Fatal("Choose") } }\n';
  const root = project(t, source, tests);
  const input = await collectGo({ root, runs: 1 });
  const metrics = {};
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '6' } }, config: config(true), metrics });
  assert.equal(mutation.mutants[0].status, 'killed');
  assert.equal(metrics.switched, 0);
  assert.equal(metrics.individual, 1);
  assert.equal(metrics.timing.prepared.refused, 2);
});

test('Go switches-off mismatch makes the package use individual builds', { timeout: 120_000 }, async (t) => {
  if (!hasVerifiedGo(t)) return;
  const source = 'package fixture\n\nfunc Choose(n int) int { return n + 1 }\n';
  const tests = `package fixture

import "testing"

func TestChoose(t *testing.T) {
	t.Setenv("CUPEL_FAULT", "1")
	if Choose(2) != 3 { t.Fatal("Choose") }
}
`;
  const root = project(t, source, tests);
  const input = await collectGo({ root, runs: 1 });
  const metrics = {};
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '3' } }, config: config(true), metrics });
  assert.equal(mutation.mutants[0].status, 'killed');
  assert.equal(metrics.switched, 0);
  assert.equal(metrics.individual, 1);
  assert.equal(metrics.timing.prepared.sensitive, 1);
});

test('Go switched compile failure falls back to the individual fault build', { timeout: 120_000 }, async (t) => {
  if (!hasVerifiedGo(t)) return;
  const source = `package fixture

func Choose(n int) int { return n + 1 }

func Label() string { return "a" + "b" }
`;
  const tests = `package fixture

import "testing"

func TestChoose(t *testing.T) { if Choose(2) != 3 { t.Fatal("Choose") } }
func TestLabel(t *testing.T) { if Label() != "ab" { t.Fatal("Label") } }
`;
  const root = project(t, source, tests);
  const input = await collectGo({ root, runs: 1 });
  const metrics = {};
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '3' } }, config: config(true), metrics });
  assert.equal(mutation.mutants[0].status, 'killed');
  assert.equal(metrics.switched, 0);
  assert.equal(metrics.individual, 1);
  assert.equal(metrics.timing.prepared.compileFallback, 1);
});

test('Go package switching refuses helper collisions and source-position readers', (t) => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'value.go');
  const pkg = { name: 'fixture', dir: root, files: [{ path: file, production: true }] };
  writeFileSync(file, 'package fixture\nvar _cupelFaultActiveValue uint32\n');
  assert.equal(goPackageSwitchReason(pkg), 'helper-name');
  writeFileSync(file, 'package fixture\nfunc f() { _, _, _, _ = runtime.Caller(0) }\n');
  assert.equal(goPackageSwitchReason(pkg), 'position');
  writeFileSync(file, 'package fixture\nfunc helper(t T) { t.Helper() }\n');
  assert.equal(goPackageSwitchReason(pkg), 'position');
  pkg.files[0].production = false;
  assert.equal(goPackageSwitchReason(pkg), null);
  writeFileSync(join(root, 'zz_cupel_fault.go'), 'package fixture\n');
  assert.equal(goPackageSwitchReason(pkg), 'helper-file');
});
