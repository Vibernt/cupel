// The node:test collector on the adapter fixture (spec/conformance/adapters/node-test): it must match
// expected.json exactly (SPEC 16 matching), validate against input.schema.json, and run through the engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  for (const t of input.tests) assert.equal(t.durationsMs.length, 2);
  const ids = input.tests.map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort());
  // Rows share one shape, keyed by the unit; single tests by their id.
  assert.deepEqual(Object.keys(input.shapes).sort(), [
    'tests/math.test.mjs::@15',
    'tests/math.test.mjs::add sums two numbers [critical]',
    'tests/math.test.mjs::clamp > low bound',
  ]);
});
