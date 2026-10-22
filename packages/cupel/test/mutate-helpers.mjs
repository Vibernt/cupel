// A small synthetic node:test project for the mutation tests, written to a temporary directory, with a
// hand-made cupel-spec/1 input (the collector is a separate part).
//
// src/calc.mjs
//   line 2 `if (x > 10) return 10;`  `>` -> `<=` is killed by exactly one test; `>` -> `>=` survives
//   line 3 `return x;`               survives (its result is never asserted)
//   line 8 `while (i < n) i += 1;`   `+=` -> `-=` loops forever: a timeout
// src/guard.mjs
//   line 2 `if (!ok) process.exit(1);`  dropping the `!` exits the process before any test reports: a crash
//   line 5 runs at module load: `!==` -> `===` throws while the test file loads, which node:test reports as a
//          failing test named after the file (a kill, credited to every test of that file)

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const CALC = `export function clamp(x) {
  if (x > 10) return 10;
  return x;
}

export function spin(n) {
  let i = 0;
  while (i < n) i += 1;
  return i;
}
`;

const CALC_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, spin } from '../src/calc.mjs';

test('clamp caps big values', () => { assert.equal(clamp(50), 10); });
test('clamp touches small values', () => { clamp(3); });
test('spin counts up', () => { assert.equal(spin(3), 3); });
`;

const GUARD = `export function guard(ok) {
  if (!ok) process.exit(1);
  return 'fine';
}
if (typeof guard !== 'function') throw new Error('guard is missing');
`;

const GUARD_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/guard.mjs';

test('guard lets good input through', () => { assert.equal(guard(true), 'fine'); });
`;

export const ID = {
  caps: 'tests/calc.test.mjs::clamp caps big values',
  small: 'tests/calc.test.mjs::clamp touches small values',
  spin: 'tests/calc.test.mjs::spin counts up',
  guard: 'tests/guard.test.mjs::guard lets good input through',
};

const row = (id, file) => ({ id, file, name: id.split('::')[1], status: 'passed', durationsMs: [5, 5] });

export function makeInput() {
  return {
    spec: 'cupel-spec/1',
    kind: 'input',
    runtime: { name: 'node', version: process.versions.node },
    sources: {
      'src/calc.mjs': { coverable: '1-4,6-10' },
      'src/guard.mjs': { coverable: '1-5' },
    },
    tests: [row(ID.caps, 'tests/calc.test.mjs'), row(ID.small, 'tests/calc.test.mjs'), row(ID.spin, 'tests/calc.test.mjs'), row(ID.guard, 'tests/guard.test.mjs')],
    coverage: {
      granularity: 'test',
      byTest: {
        [ID.caps]: { 'src/calc.mjs': '2' },
        [ID.small]: { 'src/calc.mjs': '2-3' },
        [ID.spin]: { 'src/calc.mjs': '7-9' },
        [ID.guard]: { 'src/guard.mjs': '2-3' },
      },
      setup: {
        'tests/calc.test.mjs': { 'src/calc.mjs': '1,6' },
        'tests/guard.test.mjs': { 'src/guard.mjs': '1,5' },
      },
      rechecked: [ID.small],
    },
  };
}

/** Writes the project; returns { root, input, cleanup }. `extra` adds or replaces files. */
export function makeProject(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cupel-mutate-test-'));
  const files = { 'package.json': '{ "type": "module", "private": true }\n', 'src/calc.mjs': CALC, 'tests/calc.test.mjs': CALC_TEST, 'src/guard.mjs': GUARD, 'tests/guard.test.mjs': GUARD_TEST, ...extra };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, input: makeInput(), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** sha256 of every file under root, by relative path (directories listed too, so new files show up). */
export function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === '.scratch') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        out[`${relative(root, p)}/`] = 'dir';
        walk(p);
      } else {
        out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

export const byLineOp = (mutation) => Object.fromEntries(mutation.mutants.map((m) => [`${m.source}:${m.line}:${m.operator}:${m.id.split(':').pop()}`, m]));
