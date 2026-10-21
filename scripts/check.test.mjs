import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations, checkDependencies, runChecks } from './check.mjs';

const NETWORK = [/\bfetch\s*\(/, /\bfrom\s+['"](node:)?(http|https)['"]/];

test('flags fetch and http imports', () => {
  const hits = findViolations("import x from 'node:https';\nawait fetch(url);\nconst ok = 1;", NETWORK);
  assert.deepEqual(hits.map((h) => h.line).sort(), [1, 2]);
});

test('clean code has no violations', () => {
  assert.deepEqual(findViolations("import { readFileSync } from 'node:fs';", NETWORK), []);
});

test('an explicit allow marker suppresses a line', () => {
  assert.deepEqual(findViolations('await fetch(u); // cupel-allow-network: --assay connector', NETWORK), []);
});

test('ranges and unjustified dependencies are rejected', () => {
  const problems = checkDependencies({ dependencies: { acorn: '^8.0.0', leftpad: '1.0.0' } }, 'acorn is justified');
  assert.equal(problems.length, 2);
  assert.match(problems[0], /acorn.*not an exact version/);
  assert.match(problems[1], /leftpad.*not justified/);
});

test('an exact, justified dependency passes', () => {
  assert.deepEqual(checkDependencies({ dependencies: { acorn: '8.14.0' } }, 'D6: acorn'), []);
});

test('this repository passes its own checks', () => {
  assert.deepEqual(runChecks(), []);
});
