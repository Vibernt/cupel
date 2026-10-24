// The node:test collector on the adapter fixture (spec/conformance/adapters/node-test): it must match
// expected.json exactly (SPEC 16 matching), validate against input.schema.json, and run through the engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../src/collect/node/index.mjs';
import { match } from '../src/conformance/match.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';

const FIXTURE = fileURLToPath(new URL('../../../spec/conformance/adapters/node-test/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}`, import.meta.url), 'utf8'));
const schemas = { input: load('input.schema.json'), config: load('config.schema.json'), report: load('report.schema.json') };
const expected = JSON.parse(readFileSync(new URL('expected.json', `file://${FIXTURE}`), 'utf8'));

const collected = collectNode({ root: FIXTURE, config: {}, runs: 2 });

test('the fixture matches expected.json exactly', async () => {
  const input = await collected;
  assert.deepEqual(match(expected, input), []);
});

test('the fixture input validates against input.schema.json', async () => {
  assert.deepEqual(validate(schemas.input, await collected), []);
});

test('the fixture input runs through the engine with exit 0', async () => {
  const { report, exit } = run('report', { input: await collected }, {}, {}, schemas);
  assert.equal(exit, 0, JSON.stringify(report.diagnostics));
  assert.deepEqual(report.diagnostics, []);
});

test('runtime, hashes, durations and order', async () => {
  const input = await collected;
  assert.deepEqual(input.runtime, { name: 'node', version: process.versions.node });
  const src = readFileSync(new URL('src/math.mjs', `file://${FIXTURE}`));
  const { createHash } = await import('node:crypto');
  assert.equal(input.sources['src/math.mjs'].hash, `sha256:${createHash('sha256').update(src).digest('hex')}`);
  for (const t of input.tests) {
    assert.equal(t.durationsMs.length, 2);
    assert.equal(t.runStatuses.length, 2);
  }
  const ids = input.tests.map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort());
  // Rows share one shape, keyed by the unit; single tests by their id.
  assert.deepEqual(Object.keys(input.shapes).sort(), [
    'tests/math.test.mjs::add sums two numbers [critical]',
    'tests/math.test.mjs::clamp > low bound',
    'tests/math.test.mjs::clamp keeps ${x} in range',
  ]);
});

test('K10 loop unit survives inserted lines; K13 marks a branch that changes across three runs', async () => {
  const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'node-k10-k13-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
    mkdirSync(join(root, '.scratch'));
    writeFileSync(join(root, '.scratch/count'), '0');
    writeFileSync(join(root, 'src/pick.mjs'), 'export function pick(n) {\n  if (n % 2) {\n    return 1;\n  }\n  return 2;\n}\n');
    const source = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport { pick } from '../src/pick.mjs';\nconst counter = new URL('../.scratch/count', import.meta.url);\nconst n = Number(readFileSync(counter, 'utf8'));\nwriteFileSync(counter, String(n + 1));\nfor (const x of [1, 2]) test(`value ${x}`, () => assert.equal(pick(n), n % 2 ? 1 : 2));\nfor (const x of [3, 4]) test(`value ${x}`, () => assert.equal(pick(n), n % 2 ? 1 : 2));\n";
    const file = join(root, 'tests/loop.test.mjs');
    writeFileSync(file, source);
    const first = await collectNode({ root, runs: 3 });
    assert.deepEqual(new Set(first.tests.map((row) => row.unit)), new Set(['tests/loop.test.mjs::value ${x}', 'tests/loop.test.mjs::value ${x} #2']));
    assert.match(first.coverage.unstable['src/pick.mjs'], /3/);
    assert.match(first.coverage.unstable['src/pick.mjs'], /5/);
    writeFileSync(file, `\n\n\n${source}`);
    writeFileSync(join(root, '.scratch/count'), '0');
    const shifted = await collectNode({ root, runs: 3 });
    assert.deepEqual(shifted.tests.map((row) => row.unit), first.tests.map((row) => row.unit));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
