import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from '../src/engine/schema.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}`, import.meta.url), 'utf8'));
const input = load('input.schema.json');
const config = load('config.schema.json');

const minimal = {
  spec: 'cupel-spec/1',
  kind: 'input',
  runtime: { name: 'node', version: '22.23.3' },
  sources: { 'src/a.mjs': { coverable: '1-10' } },
  tests: [{ id: 't1', file: 'tests/a.test.mjs', name: 'a', status: 'passed' }],
  coverage: { granularity: 'test', byTest: { t1: { 'src/a.mjs': '1-3,5' } } },
};

test('every spec schema uses only supported keywords', () => {
  for (const name of ['input', 'config', 'report', 'case']) {
    assert.doesNotThrow(() => validate(load(`${name}.schema.json`), {}), name);
  }
});

test('a minimal input is valid', () => {
  assert.deepEqual(validate(input, minimal), []);
});

test('a minor spec version is accepted, another major is not', () => {
  assert.deepEqual(validate(input, { ...minimal, spec: 'cupel-spec/1.3' }), []);
  assert.deepEqual(validate(input, { ...minimal, spec: 'cupel-spec/2' }).map((e) => e.path), ['/spec']);
});

test('errors carry JSON pointers', () => {
  const bad = { ...minimal, tests: [{ id: 't1', file: 'x', name: 'a', status: 'ok' }], extra: 1 };
  const paths = validate(input, bad).map((e) => e.path).sort();
  assert.deepEqual(paths, ['/extra', '/tests/0/status']);
});

test('line sets must be well formed', () => {
  for (const good of ['', '7', '1-3,7,10-12']) {
    assert.deepEqual(validate(input, { ...minimal, sources: { a: { coverable: good } } }), [], good);
  }
  for (const bad of ['0', '1-', ' 1', '1,,2', '-3']) {
    assert.equal(validate(input, { ...minimal, sources: { a: { coverable: bad } } }).length, 1, bad);
  }
});

test('anyOf accepts either form', () => {
  assert.deepEqual(validate(config, { guard: { criticalCoverage: 'ratchet' } }), []);
  assert.deepEqual(validate(config, { guard: { criticalCoverage: 95 } }), []);
  assert.equal(validate(config, { guard: { criticalCoverage: 'always' } }).length, 1);
});

test('unsupported keywords throw', () => {
  assert.throws(() => validate({ oneOf: [] }, 1), /unsupported schema keyword: oneOf/);
});
