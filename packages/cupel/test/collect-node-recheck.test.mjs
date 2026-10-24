// The node:test collector on a small synthetic suite written to a temporary directory: rows, nesting, a failing
// and a skipped test, a spawned node child, a brittle pin, scope, config patterns, and the per-process re-check
// (K4), which must replace the shared-process coverage of the units it runs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNode } from '../src/collect/node/index.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';
import { lines } from '../src/engine/lines.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}`, import.meta.url), 'utf8'));
const schemas = { input: load('input.schema.json'), config: load('config.schema.json'), report: load('report.schema.json') };

const LIB = `let cache = null;

// The first caller pays for the table: only it covers the two lines inside the if.
export function table() {
  if (cache === null) {
    cache = new Map();
    cache.set('a', 1);
  }
  return cache;
}

export function lookup(key) {
  return table().get(key);
}

export function double(x) {
  return x * 2;
}
`;
const CHILD = `import { double } from './lib.mjs';

export function childOnly(x) {
  return double(x) + 1;
}

process.stdout.write(String(childOnly(Number(process.argv[2]))));
`;
const SUITE = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup, double } from '../src/lib.mjs';

test('first lookup [critical]', () => {
  assert.equal(lookup('a'), 1);
});

test('second lookup [fault:x] [minor]', () => {
  assert.equal(lookup('a'), 1);
});

for (const x of [1, 2]) {
  test(\`double \${x}\`, () => {
    assert.equal(double(x), x * 2);
  });
}

describe('outer', () => {
  describe('inner', () => {
    test('nested leaf', () => {
      assert.equal(double(3), 6);
    });
  });
});

test('parent', async (t) => {
  await t.test('child one', () => {
    assert.equal(double(4), 8);
  });
  await t.test('child two', () => {
    assert.equal(double(5), 10);
  });
});

test('fails on purpose', () => {
  assert.equal(double(1), 3);
});

test('skipped', { skip: true }, () => {
  double(9);
});

test('spawns node', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/child.mjs', import.meta.url)), '2'], { encoding: 'utf8' });
  assert.equal(r.stdout, '5');
});

test('pins source text', () => {
  const text = readFileSync(new URL('../src/lib.mjs', import.meta.url), 'utf8');
  assert.match(text, /export function double/);
});

test('reads its own temporary output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cupel-syn-'));
  writeFileSync(join(dir, 'out.mjs'), 'export const x = 1;\\n');
  const text = readFileSync(join(dir, 'out.mjs'), 'utf8');
  assert.match(text, /export const x/);
});
`;

const root = mkdtempSync(join(tmpdir(), 'cupel-collect-'));
mkdirSync(join(root, 'src/ignored'), { recursive: true });
mkdirSync(join(root, 'tests'));
mkdirSync(join(root, '.hidden'));
writeFileSync(join(root, 'src/lib.mjs'), LIB);
writeFileSync(join(root, 'src/child.mjs'), CHILD);
writeFileSync(join(root, 'src/ignored/skip.mjs'), 'export const x = 1;\n');
writeFileSync(join(root, '.hidden/x.mjs'), 'export const x = 1;\n');
writeFileSync(join(root, 'tests/helper.mjs'), 'export const y = 1;\n');
writeFileSync(join(root, 'tests/syn.test.mjs'), SUITE);
after(() => rmSync(root, { recursive: true, force: true }));

const F = 'tests/syn.test.mjs';
const id = (name) => `${F}::${name}`;
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const has = (set, line) => lines(set ?? '').some(([s, e]) => s <= line && line <= e);
const config = {
  scope: { exclude: ['src/ignored/**'] },
  brittleness: {
    patterns: [
      { kind: 'file-snapshot', pattern: 'spawnSync\\(', deliberate: true },
      { kind: 'doc-wording', language: 'python', pattern: 'double' },
    ],
  },
};
const ROWS = `${F}::double ${'${x}'}`;
const shared = collectNode({ root, config, runs: 2 });
const rechecked = collectNode({ root, config, runs: 1, recheck: [id('second lookup [fault:x] [minor]'), id('spawns node'), id('parent > child one'), ROWS, 'tests/nope.test.mjs::x'] });

test('tests: ids, rows, nesting, status, tags and child interpreters', async () => {
  const input = await shared;
  const byId = new Map(input.tests.map((t) => [t.id, t]));
  assert.deepEqual(input.tests.map((t) => t.id), [
    'double 1', 'double 2', 'fails on purpose', 'first lookup [critical]', 'outer > inner > nested leaf', 'parent > child one',
    'parent > child two', 'pins source text', 'reads its own temporary output', 'second lookup [fault:x] [minor]', 'skipped', 'spawns node',
  ].map(id));
  assert.equal(byId.get(id('double 1')).unit, ROWS);
  assert.equal(byId.get(id('double 2')).unit, ROWS);
  assert.equal(byId.get(id('outer > inner > nested leaf')).unit, undefined);
  assert.equal(byId.get(id('outer > inner > nested leaf')).name, 'outer > inner > nested leaf');
  assert.equal(byId.get(id('fails on purpose')).status, 'failed');
  assert.equal(byId.get(id('skipped')).status, 'skipped');
  assert.equal(byId.get(id('double 1')).status, 'passed');
  assert.deepEqual(byId.get(id('first lookup [critical]')).tags, ['critical']);
  assert.deepEqual(byId.get(id('second lookup [fault:x] [minor]')).tags, ['minor']);
  assert.equal(byId.get(id('double 1')).tags, undefined);
  assert.equal(byId.get(id('spawns node')).spawnsInterpreter, true);
  assert.equal(byId.get(id('double 1')).spawnsInterpreter, undefined);
  for (const t of input.tests) assert.equal(t.durationsMs.length, 2);
});

test('sources: scope, coverable lines and hashes', async () => {
  const input = await shared;
  assert.deepEqual(Object.keys(input.sources), ['src/child.mjs', 'src/lib.mjs']);
  // Blank and comment lines are not coverable.
  assert.equal(has(input.sources['src/lib.mjs'].coverable, 2), false);
  assert.equal(has(input.sources['src/lib.mjs'].coverable, 3), false);
  assert.equal(has(input.sources['src/lib.mjs'].coverable, 4), true);
  assert.match(input.sources['src/lib.mjs'].hash, /^sha256:[0-9a-f]{64}$/);
});

test('coverage: per test, setup, skipped tests have none, first touch in the shared process', async () => {
  const input = await shared;
  const cov = input.coverage.byTest;
  const init = lineOf(LIB, 'cache = new Map()');
  const dbl = lineOf(LIB, 'return x * 2');
  assert.equal(has(cov[id('first lookup [critical]')]['src/lib.mjs'], init), true);
  assert.equal(has(cov[id('second lookup [fault:x] [minor]')]['src/lib.mjs'], init), false, 'the shared process gives the init to the first test only');
  assert.equal(has(cov[id('double 1')]['src/lib.mjs'], dbl), true);
  assert.equal(has(cov[id('parent > child one')]['src/lib.mjs'], dbl), true);
  assert.equal(has(cov[id('outer > inner > nested leaf')]['src/lib.mjs'], dbl), true);
  assert.equal(cov[id('skipped')], undefined);
  assert.equal(cov[id('parent')], undefined);
  assert.equal(cov[id('spawns node')]['src/child.mjs'], undefined, 'the in-process method cannot see the child');
  assert.equal(has(input.coverage.setup[F]['src/lib.mjs'], lineOf(LIB, 'let cache')), true);
  assert.equal(input.coverage.rechecked, undefined);
});

test('brittleness: the strict detector, temporary reads and config patterns', async () => {
  const input = await shared;
  assert.deepEqual(input.brittleness, [
    { test: id('pins source text'), kind: 'source-text', line: lineOf(SUITE, "readFileSync(new URL('../src/lib.mjs'") },
    { test: id('spawns node'), kind: 'file-snapshot', line: lineOf(SUITE, 'const r = spawnSync'), deliberate: true },
  ]);
});

test('shapes: rows share one shape keyed by the unit', async () => {
  const input = await shared;
  assert.ok(input.shapes[ROWS].length > 0);
  assert.equal(input.shapes[id('double 1')], undefined);
  for (const s of Object.values(input.shapes)) assert.deepEqual(s, [...new Set(s)].sort((a, b) => a - b));
});

test('re-check: each unit alone replaces its shared coverage, child coverage included (K4)', async () => {
  const input = await rechecked;
  assert.deepEqual(input.coverage.rechecked, [ROWS, id('parent > child one'), id('second lookup [fault:x] [minor]'), id('spawns node')].sort());
  const cov = input.coverage.byTest;
  assert.equal(has(cov[id('second lookup [fault:x] [minor]')]['src/lib.mjs'], lineOf(LIB, 'cache = new Map()')), true, 'alone, the test covers the init');
  assert.equal(has(cov[id('spawns node')]['src/child.mjs'], lineOf(CHILD, 'return double(x) + 1')), true, 'the node child is seen');
  assert.equal(has(cov[id('spawns node')]['src/lib.mjs'], lineOf(LIB, 'return x * 2')), true);
  assert.equal(has(cov[id('parent > child one')]['src/lib.mjs'], lineOf(LIB, 'return x * 2')), true);
  assert.equal(has(cov[id('double 2')]['src/lib.mjs'], lineOf(LIB, 'return x * 2')), true);
});

test('both inputs validate and run through the engine', async () => {
  for (const input of [await shared, await rechecked]) {
    assert.deepEqual(validate(schemas.input, input), []);
    const { report, exit } = run('report', { input }, config, {}, schemas);
    assert.equal(exit, 0, JSON.stringify(report.diagnostics));
  }
});
