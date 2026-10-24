// Shared helpers for the engine tests. Every run through `go` also proves R1 determinism (the same
// call twice gives byte-identical JSON) and that the report validates against report.schema.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../src/engine/index.mjs';
import { validate } from '../src/engine/schema.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}`, import.meta.url), 'utf8'));
export const schemas = { input: load('input.schema.json'), config: load('config.schema.json'), report: load('report.schema.json') };

export const clone = (v) => JSON.parse(JSON.stringify(v));

export function go(command, inputs, config = {}, args = {}) {
  const snapshot = JSON.stringify([inputs, config, args]);
  const a = run(command, clone(inputs), clone(config), clone(args), schemas);
  const b = run(command, clone(inputs), clone(config), clone(args), schemas);
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report), 'R1: same call, same JSON');
  assert.equal(a.exit, b.exit);
  assert.deepEqual(validate(schemas.report, a.report), [], 'report validates against report.schema.json');
  assert.equal(JSON.stringify([inputs, config, args]), snapshot, 'the engine does not mutate its arguments');
  // The engine must not mutate the objects it is given either.
  const c = clone(inputs);
  run(command, c, clone(config), clone(args), schemas);
  assert.deepEqual(c, inputs);
  return a;
}

export const FILE = 'tests/a.test.mjs';

/** A passed test row in tests/a.test.mjs, named after its id. */
export const t = (id, extra = {}) => ({ id, file: FILE, name: id, status: 'passed', durationsMs: [10, 10], ...extra });

/**
 * Builds an input. `cov` maps test id -> { source: lines }.
 * Defaults: one source `src/a.mjs` with lines 1-100.
 */
export function input({
  sources = { 'src/a.mjs': { coverable: '1-100' } },
  tests = [],
  cov = {},
  granularity = 'test',
  byFile,
  setup,
  unstable,
  rechecked,
  mutants,
  targeted,
  brittleness,
  shapes,
  runtime = { name: 'node', version: '22.0.0' },
} = {}) {
  const coverage = { granularity };
  if (granularity === 'test') coverage.byTest = cov;
  if (byFile) coverage.byFile = byFile;
  if (setup) coverage.setup = setup;
  if (unstable) coverage.unstable = unstable;
  if (rechecked) coverage.rechecked = rechecked;
  const doc = { spec: 'cupel-spec/1', kind: 'input', runtime, sources, tests, coverage };
  if (mutants) doc.mutation = { mutants, ...(targeted ? { targeted } : {}) };
  if (brittleness) doc.brittleness = brittleness;
  if (shapes) doc.shapes = shapes;
  return doc;
}

export const report = (doc, config, args) => go('report', { input: doc }, config, args);

export const unit = (rep, id) => {
  const u = rep.report.units.find((x) => x.id === id);
  assert.ok(u, `unit ${id} in report`);
  return u;
};

export const codes = (rep) => rep.report.diagnostics.map((d) => d.code);

export const mutant = (id, line, killedBy, status = 'killed', source = 'src/a.mjs') => ({ id, source, line, operator: 'op', status, killedBy });
