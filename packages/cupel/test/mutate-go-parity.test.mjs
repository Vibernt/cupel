import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseInventory } from '../src/mutate-go/inventory.mjs';
import { orderGoPackages, shouldStopGo } from '../src/mutate-go/order.mjs';
import { classifyGo } from '../src/mutate-go/results.mjs';
import { goReuseBasisValid, goRunRegex, selectGoTests } from '../src/mutate-go/selection.mjs';

const tests = [
  { id: 'a_test.go::TestA', file: 'a_test.go', name: 'TestA', status: 'passed', durationsMs: [9] },
  { id: 'a_test.go::TestB', file: 'a_test.go', name: 'TestB', status: 'passed', durationsMs: [10] },
  { id: 'b_test.go::TestC', file: 'b_test.go', name: 'TestC', status: 'passed', durationsMs: [1] },
];

test('pure Go run regex anchors, sorts, deduplicates and escapes names', () => {
  assert.equal(goRunRegex(['TestB', 'TestA', 'TestA']), '^(?:TestA|TestB)$');
  assert.equal(goRunRegex(['Test[One].*']), '^Test\\[One\\]\\.\\*$');
  assert.equal(goRunRegex(['TestB', 'TestA'], { examples: true, fuzz: true }),
    '^(?:TestA|TestB)$|^Example|^Fuzz');
  assert.throws(() => goRunRegex([]), /at least one/);
});

test('pure Go selection expands setup coverage to every test in its package', () => {
  const input = { tests, coverage: {
    byTest: { 'b_test.go::TestC': { 'value.go': '7' } },
    setup: { 'a_test.go': { 'value.go': '7' } },
  } };
  const inventory = {
    testPkg: new Map([['a_test.go', 'example/a'], ['b_test.go', 'example/b']]),
    testsByPackage: new Map([['example/a', tests.slice(0, 2)], ['example/b', tests.slice(2)]]),
  };
  const selected = selectGoTests(input, inventory, { source: 'value.go', line: 7 });
  assert.deepEqual(selected.tests.map((row) => row.id), tests.map((row) => row.id));
  assert.deepEqual([...selected.packages.get('example/a').names], ['TestA', 'TestB']);
});

test('pure Go inventory refuses an omitted source-defined top-level test', (t) => {
  const base = resolve('.scratch', 'mutate-go-parity');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'value.go'), 'package fixture\n\nfunc Value() int { return 1 }\n');
  writeFileSync(join(root, 'value_test.go'), `package fixture\n\nimport "testing"\n\nfunc TestOne(t *testing.T) {}\nfunc TestTwo(t *testing.T) {}\n`);
  const input = { sources: { 'value.go': {} }, tests: [
    { id: 'value_test.go::TestOne', file: 'value_test.go', name: 'TestOne', status: 'passed' },
  ] };
  const listing = JSON.stringify({ ImportPath: 'example.com/fixture', Dir: root,
    GoFiles: ['value.go'], TestGoFiles: ['value_test.go'] });
  assert.throws(() => parseInventory(root, listing, input), { code: 'isolation-mismatch' });
});

test('pure Go reuse requires every test file in each compiled package to be in the K15 basis', () => {
  const input = { tests, coverage: { byTest: {
    'a_test.go::TestA': { 'value.go': '7' },
  }, setup: {} } };
  const inventory = {
    sourcePkg: new Map([['value.go', 'example/pkg']]),
    testPkg: new Map([['a_test.go', 'example/pkg'], ['b_test.go', 'example/pkg']]),
    testsByPackage: new Map([['example/pkg', tests]]),
  };
  const site = { source: 'value.go', line: 7 };
  assert.equal(goReuseBasisValid(input, inventory, site), false);
  input.coverage.setup['b_test.go'] = { 'value.go': '7' };
  assert.equal(goReuseBasisValid(input, inventory, site), true);
});

test('pure Go package order uses catch history, same-file package, count, input time and name', () => {
  const packages = new Map([
    ['slow', { tests: [{}, {}] }],
    ['near', { tests: [{}] }],
    ['caught', { tests: [{}] }],
    ['a', { tests: [{}] }],
    ['b', { tests: [{}] }],
  ]);
  const durations = new Map([['slow', 50], ['near', 1], ['caught', 100], ['a', 3], ['b', 3]]);
  assert.deepEqual(orderGoPackages({
    packages,
    previousCatchers: ['test::caught'],
    packageOfTest: (id) => id === 'test::caught' ? 'caught' : undefined,
    nearPackages: ['near'],
    inputMs: (pkg) => durations.get(pkg),
  }), ['caught', 'near', 'slow', 'a', 'b']);
});

test('pure Go partial classification never treats unrun tests as passed and credits reported catches', () => {
  const input = { tests };
  const group = tests.slice(0, 2);
  const result = (extra = {}) => ({ status: 0, signal: null, timedOut: false, ...extra });
  const parsed = (entries, failures = []) => ({ statuses: new Map(entries), packageFailures: new Set(failures) });
  assert.deepEqual(classifyGo(input, result(), parsed([[tests[0].id, 'passed'], [tests[1].id, 'passed']]), group),
    { status: 'survived', killedBy: [] });
  assert.deepEqual(classifyGo(input, result(), parsed([[tests[0].id, 'passed']]), group),
    { status: 'error', killedBy: [] });
  assert.deepEqual(classifyGo(input, result({ status: 7 }), parsed([[tests[0].id, 'failed']]), group),
    { status: 'error', killedBy: [] });
  assert.deepEqual(classifyGo(input, result({ status: null, signal: 'SIGKILL', timedOut: true }),
    parsed([[tests[0].id, 'failed']]), group), { status: 'killed', killedBy: [tests[0].id] });
});

test('pure Go stop rule needs two catches, one in first-catch mode, and never truncates targeted units', () => {
  assert.equal(shouldStopGo({ catching: 1 }), false);
  assert.equal(shouldStopGo({ catching: 2 }), true);
  assert.equal(shouldStopGo({ catching: 1, firstCatch: true }), true);
  assert.equal(shouldStopGo({ catching: 9, firstCatch: true, targeted: true }), false);
});
