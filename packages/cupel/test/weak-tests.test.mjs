// No-assertion and tautology findings for Rust and JavaScript tests (test-quality audit, phase 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitions } from '../src/collect/cargo/tests.mjs';
import { analyseTestFile } from '../src/collect/node/testfile.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('Rust: planted false tests are flagged; honest, helper, macro and panic tests are not', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/weak-rust-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/lib.rs'), `
pub fn add(a: i32, b: i32) -> i32 { a + b }
fn check_sum(x: i32) { assert_eq!(x, 3); }
fn wraps(x: i32) { check_sum(x) }
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn real() { assert_eq!(add(1, 2), 3); }
    #[test] fn removed_assertions() { let _ = add(1, 2); }
    #[test] fn always_true() { assert!(true); }
    #[test] fn self_compare() { let x = add(1, 2); assert_eq!(x, x); }
    #[test] fn same_expr() { assert!(add(1, 2) == add(1, 2)); }
    #[test] fn no_assertion() { add(1, 2); }
    #[test] fn via_helper() { check_sum(add(1, 2)); }
    #[test] fn via_two_helpers() { wraps(add(1, 2)); }
    #[test] fn via_unwrap() { "3".parse::<i32>().unwrap(); }
    #[test] fn via_question() -> Result<(), std::num::ParseIntError> { "3".parse::<i32>()?; Ok(()) }
    #[test] fn via_common() { common::run(add(1, 2)); }
    #[test] fn via_macro() { my_check!(add(1, 2)); }
    #[test] #[should_panic] fn panics() { add(1, 2); }
    #[test] fn prints_only() { println!("{}", add(1, 2)); }
    #[test] fn inequality_is_not_a_tautology() { assert!(add(1, 2) != add(2, 2)); }
}
`);
    const got = Object.fromEntries(definitions(root).map((d) => [d.fullName.replace('tests::', ''), d.brittleness.map((b) => b.kind)]));
    assert.deepEqual(got, {
      real: [], removed_assertions: ['no-assertion'], always_true: ['tautology'], self_compare: ['tautology'], same_expr: [],
      no_assertion: ['no-assertion'], via_helper: [], via_two_helpers: [], via_unwrap: [], via_question: [], via_common: [], via_macro: [],
      panics: [], prints_only: ['no-assertion'], inequality_is_not_a_tautology: [],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('JavaScript: planted false tests are flagged; helpers, subtests, throws and plans are not', () => {
  const src = `
import { test, it } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/add.mjs';
import { runCase } from './helpers.mjs';
const { checkLater } = require('./support/checks.js');
function checkSum(x) { assert.equal(x, 3); }
const viaArrow = (x) => { expect(x).toBe(3); };
test('real', () => { assert.equal(add(1, 2), 3); });
test('removed assertions', () => { const x = add(1, 2); });
test('always true', () => { assert.ok(true); });
test('bare true', () => { assert(true); });
test('self compare', () => { const x = add(1, 2); assert.equal(x, x); });
test('expect same', () => { expect(add(1, 2)).toBe(add(1, 2)); });
test('expect truthy', () => { expect(true).toBeTruthy(); });
test('no assertion', () => { add(1, 2); });
test('via helper', () => { checkSum(add(1, 2)); });
test('via arrow helper', () => { viaArrow(add(1, 2)); });
test('via imported helper', () => { runCase(add(1, 2)); });
test('via required helper', () => { checkLater(add(1, 2)); });
test('subtests', async (t) => { await t.test('inner', () => { assert.ok(add(1, 2)); }); });
test('throws', () => { if (add(1, 2) !== 3) throw new Error('x'); });
test('plan', (t) => { t.plan(1); t.assert.ok(add(1, 2)); });
test('rejects', async () => { await assert.rejects(add(1, 2)); });
test('inequality', () => { assert.notEqual(add(1, 2), add(2, 2)); });
`;
  const got = Object.fromEntries(analyseTestFile(src).filter((d) => d.title !== 'inner').map((d) => [d.title, d.flags.map((f) => f.kind)]));
  assert.deepEqual(got, {
    real: [], 'removed assertions': ['no-assertion'], 'always true': ['tautology'], 'bare true': ['tautology'], 'self compare': ['tautology'],
    'expect same': [], 'expect truthy': ['tautology'], 'no assertion': ['no-assertion'], 'via helper': [], 'via arrow helper': [],
    'via imported helper': [], 'via required helper': [], subtests: [], throws: [], plan: [], rejects: [], inequality: [],
  });
});
