import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAULT_MODULE, faultModule, lexRust, switchFaults } from '../src/mutate-cargo/schemata.mjs';

// Span of the `occ`-th occurrence of `needle` (cargo-mutants style: 1-based
// lines, 1-based columns in Unicode scalar values, exclusive end).
function at(text, needle, occ = 0, len = needle.length) {
  let idx = -1;
  for (let k = 0; k <= occ; k++) { idx = text.indexOf(needle, idx + 1); if (idx < 0) throw new Error(`no ${needle} #${occ}`); }
  const pos = (o) => {
    const before = text.slice(0, o);
    const ls = before.lastIndexOf('\n') + 1;
    return { line: before.split('\n').length, column: [...text.slice(ls, o)].length + 1 };
  };
  return { start: pos(idx), end: pos(idx + len) };
}

// Span of `len` characters at offset `off` inside the unique occurrence of `needle`.
function sub(text, needle, off = 0, len = needle.length - off) {
  const idx = text.indexOf(needle);
  if (idx < 0 || text.indexOf(needle, idx + 1) >= 0) throw new Error(`needle not unique: ${needle}`);
  const pos = (o) => {
    const before = text.slice(0, o);
    const ls = before.lastIndexOf('\n') + 1;
    return { line: before.split('\n').length, column: [...text.slice(ls, o)].length + 1 };
  };
  return { start: pos(idx + off), end: pos(idx + off + len) };
}
const op = (number, text, needle, off, len, replacement) => ({ number, genre: 'BinaryOperator', span: sub(text, needle, off, len), replacement });

const bin = (number, text, op, replacement, occ = 0) => ({ number, genre: 'BinaryOperator', span: at(text, op, occ), replacement });
const un = (number, text, op, occ = 0) => ({ number, genre: 'UnaryOperator', span: at(text, op, occ, 1), replacement: '' });
const fnv = (number, text, body, replacement) => ({ number, genre: 'FnValue', span: at(text, body), replacement });

function brackets(toks) {
  const m = new Array(toks.length); const st = [];
  toks.forEach((t, k) => { if (t.k === 'o') st.push(k); if (t.k === 'c') { const o = st.pop(); m[o] = k; m[k] = o; } });
  return m;
}

// Undo the rewrite: keep each switch's original (else) branch, drop FnValue
// guards. Returns tokens with their line numbers.
function unswitch(out, path) {
  const toks = lexRust(out); const m = brackets(toks);
  const P = lexRust(path).map((t) => t.v);
  const lineOf = (s) => out.slice(0, s).split('\n').length;
  const res = [];
  const walk = (a, b) => {
    for (let k = a; k < b;) {
      if (toks[k].v === 'if' && P.every((v, x) => toks[k + 1 + x]?.v === v) && toks[k + 1 + P.length]?.v === '(') {
        const open = m[k + 1 + P.length] + 1; const close = m[open];
        if (toks[close + 1]?.v === 'else') { const eo = close + 2; walk(eo + 1, m[eo]); k = m[eo] + 1; } else k = close + 1;
        continue;
      }
      res.push({ v: toks[k].v, line: lineOf(toks[k].s) }); k++;
    }
  };
  walk(0, toks.length);
  return res;
}

const plain = (text) => lexRust(text).map((t) => ({ v: t.v, line: text.slice(0, t.s).split('\n').length }));
const noParens = (list) => list.filter((t) => t.v !== '(' && t.v !== ')');

function check(src, faults, path = 'on') {
  const r = switchFaults(src, faults, { path });
  assert.equal(r.text.split('\n').length, src.split('\n').length, 'line count');
  assert.deepEqual(noParens(unswitch(r.text, path)), noParens(plain(src)), 'else branches give back the original tokens on their lines');
  assert.deepEqual([...r.switched, ...r.refused.map((x) => x.number)].sort((a, b) => a - b), faults.map((f) => f.number).sort((a, b) => a - b));
  return r;
}
const line = (r, n) => r.text.split('\n')[n - 1];
const reason = (r, n) => r.refused.find((x) => x.number === n)?.reason;

test('fault module is one line and exported both ways', () => {
  assert.equal(faultModule(), FAULT_MODULE);
  assert.ok(!FAULT_MODULE.includes('\n'));
  assert.match(FAULT_MODULE, /pub mod __cupel_faults \{ pub fn on\(n: u32\) -> bool/);
  assert.match(FAULT_MODULE, /OnceLock/);
  assert.match(FAULT_MODULE, /CUPEL_FAULT/);
});

test('a == b', () => {
  const src = 'fn f(a: u8, b: u8) -> bool {\n    let t = a == b;\n    t\n}\n';
  const r = check(src, [bin(1, src, '==', '!=')]);
  assert.deepEqual(r.switched, [1]);
  assert.equal(line(r, 2), '    let t = if on(1) { (a) != (b) } else { (a) == (b) };');
});

test('default path and parentheses where precedence needs them', () => {
  const src = 'fn f(a: u8, b: u8) -> bool {\n    a == b || a > 3\n}\n';
  const r = check(src, [bin(1, src, '=='), bin(2, src, '||', '&&')].map((f) => ({ ...f, replacement: f.replacement ?? '!=' })), 'crate::__cupel_faults::on');
  assert.equal(line(r, 2), '    if crate::__cupel_faults::on(2) { (a == b) && (a > 3) } else { (if crate::__cupel_faults::on(1) { (a) != (b) } else { (a) == (b) }) || (a > 3) }');
});

test('a + b * c: fault on + and on *', () => {
  const src = 'fn f(a: i32, b: i32, c: i32) -> i32 {\n    let x = a + b * c;\n    x\n}\n';
  let r = check(src, [bin(1, src, '+', '-')]);
  assert.equal(line(r, 2), '    let x = if on(1) { (a) - (b * c) } else { (a) + (b * c) };');
  r = check(src, [bin(2, src, '*', '/')]);
  assert.equal(line(r, 2), '    let x = a + (if on(2) { (b) / (c) } else { (b) * (c) });');
  r = check(src, [bin(1, src, '+', '-'), bin(2, src, '*', '/')]);
  assert.equal(line(r, 2), '    let x = if on(1) { (a) - (b * c) } else { (a) + (if on(2) { (b) / (c) } else { (b) * (c) }) };');
});

test('a - b - c: both faults, left associative', () => {
  const src = 'fn f(a: i32, b: i32, c: i32) -> i32 {\n    a - b - c\n}\n';
  const first = op(1, src, 'a - b', 2, 1, '+');
  const second = op(2, src, 'b - c', 2, 1, '/');
  const r = check(src, [first, second]);
  assert.equal(line(r, 2), '    if on(2) { (a - b) / (c) } else { (if on(1) { (a) + (b) } else { (a) - (b) }) - (c) }');
});

test('x.len() < 2 && !flag', () => {
  const src = 'fn f(x: &[u8], flag: bool) -> bool {\n    x.len() < 2 && !flag\n}\n';
  const r = check(src, [bin(1, src, '&&', '||'), bin(2, src, '<', '=='), un(3, src, '!')]);
  assert.deepEqual(r.switched, [1, 2, 3]);
  assert.equal(line(r, 2), '    if on(1) { (x.len() < 2) || (!flag) } else { (if on(2) { (x.len()) == (2) } else { (x.len()) < (2) }) && (if on(3) { flag } else { !(flag) }) }');
});

test('-x as i64 + 1: unary binds tighter than as', () => {
  const src = 'fn f(x: i32) -> i64 {\n    -x as i64 + 1\n}\n';
  const r = check(src, [{ number: 1, genre: 'UnaryOperator', span: sub(src, '-x', 0, 1), replacement: '' }, bin(2, src, '+', '-')]);
  assert.equal(line(r, 2), '    if on(2) { (-x as i64) - (1) } else { ((if on(1) { x } else { -(x) }) as i64) + (1) }');
});

test('iterator chain with closure and turbofish', () => {
  const src = 'fn f(v: Vec<i32>) -> bool {\n    v.iter().map(|x| x * 2).sum::<i32>() == 6\n}\n';
  const r = check(src, [bin(1, src, '==', '!='), bin(2, src, '*', '+')]);
  assert.equal(line(r, 2), '    if on(1) { (v.iter().map(|x| x * 2).sum::<i32>()) != (6) } else { (v.iter().map(|x| if on(2) { (x) + (2) } else { (x) * (2) }).sum::<i32>()) == (6) }');
});

test('if a == b { ... }: the brace is the body, not a struct literal', () => {
  const src = 'fn f(a: u8, b: u8) -> u8 {\n    if a == b { 1 } else { 2 }\n}\n';
  const r = check(src, [bin(1, src, '==', '!=')]);
  assert.equal(line(r, 2), '    if if on(1) { (a) != (b) } else { (a) == (b) } { 1 } else { 2 }');
  const w = 'fn g(mut i: u8, n: u8) {\n    while i < n { i += 1; }\n}\n';
  const rw = check(w, [bin(1, w, '<', '>'), bin(2, w, '+=', '-=')]);
  assert.equal(line(rw, 2), '    while if on(1) { (i) > (n) } else { (i) < (n) } { if on(2) { i -= 1 } else { i += 1 }; }');
});

test('operands that begin or end with a block are refused', () => {
  const src = [
    'struct S { a: u8 }',
    'fn f(x: u8, c: bool, s: S) -> bool {',
    '    let p = x == S { a: 1 }.a;',
    '    let t = x == { 3 };',
    '    let u = x == S { a: 2 };',
    '    p && t && u && s.a == 0',
    '}', '',
  ].join('\n');
  const r = check(src, [op(1, src, 'x == S { a: 1 }', 2, 2, '!='), op(2, src, 'x == { 3 }', 2, 2, '!='), op(3, src, 'x == S { a: 2 }', 2, 2, '!='),
    op(4, src, 's.a == 0', 4, 2, '!=')]);
  assert.deepEqual(r.refused, [{ number: 2, reason: 'ambiguous' }, { number: 3, reason: 'ambiguous' }]);
  assert.equal(line(r, 3), '    let p = if on(1) { (x) != (S { a: 1 }.a) } else { (x) == (S { a: 1 }.a) };');
});

test('match and if operands are refused precisely', () => {
  const src = 'fn f(x: u8, c: bool) -> u8 {\n    let q = match x { _ => 1 } + 2;\n    let r = 1 + if c { 1 } else { 2 };\n    q * r\n}\n';
  const plus0 = { number: 1, genre: 'BinaryOperator', span: at(src, '+', 0, 1), replacement: '-' };
  const plus1 = { number: 2, genre: 'BinaryOperator', span: at(src, '+', 1, 1), replacement: '-' };
  const r = check(src, [plus0, plus1, bin(3, src, '*', '+')]);
  assert.equal(reason(r, 1), 'ambiguous');
  assert.equal(reason(r, 2), 'ambiguous');
  assert.deepEqual(r.switched, [3]);
  assert.equal(line(r, 4), '    if on(3) { (q) + (r) } else { (q) * (r) }');
});

test('x >= y vs generics Vec<Vec<u8>>', () => {
  const src = 'fn f(x: u8, y: u8) -> bool {\n    let v: Vec<Vec<u8>> = Vec::<Vec<u8>>::new();\n    x >= y && v.len() > 0\n}\n';
  const gt = { number: 2, genre: 'BinaryOperator', span: at(src, '>>', 0, 2), replacement: '<<' };
  const tf = { number: 4, genre: 'BinaryOperator', span: at(src, '>>', 1, 2), replacement: '<<' };
  const r = check(src, [bin(1, src, '>=', '<'), gt, op(3, src, 'len() > 0', 6, 1, '<'), tf]);
  assert.equal(reason(r, 2), 'pattern');
  assert.equal(reason(r, 4), 'generic');
  assert.ok(r.switched.includes(1) && r.switched.includes(3));
  assert.equal(line(r, 3), '    (if on(1) { (x) < (y) } else { (x) >= (y) }) && (if on(3) { (v.len()) < (0) } else { (v.len()) > (0) })');
});

test('a >> 1 is a shift; >> closing generics is not', () => {
  const src = 'fn f(a: u32) -> u32 {\n    let n = Vec::<Vec<u32>>::new().len() as u32;\n    (a >> 1) + n\n}\n';
  const r = check(src, [{ number: 1, genre: 'BinaryOperator', span: at(src, '>>', 1, 2), replacement: '<<' }, { number: 2, genre: 'BinaryOperator', span: at(src, '>>', 0, 2), replacement: '<<' }]);
  assert.deepEqual(r.switched, [1]);
  assert.equal(reason(r, 2), 'generic');
  assert.equal(line(r, 3), '    (if on(1) { (a) << (1) } else { (a) >> (1) }) + n');
});

test('compound assignment as a statement; refused elsewhere', () => {
  const src = 'fn f(xs: &[u32]) -> u32 {\n    let mut total = 0;\n    for n in xs { total += n; }\n    let g = |t: &mut u32| *t <<= 1;\n    total\n}\n';
  const r = check(src, [bin(1, src, '+=', '-='), bin(2, src, '<<=', '>>=')]);
  assert.equal(line(r, 3), '    for n in xs { if on(1) { total -= n } else { total += n }; }');
  assert.equal(reason(r, 2), 'statement');
  const tail = 'fn g(mut x: u32) { x *= 2 }\n';
  assert.equal(reason(check(tail, [bin(1, tail, '*=', '/=')]), 1), 'statement');
  const idx = 'fn h(v: &mut [u32], i: usize) {\n    v[i + 1] ^= v[i] + 2;\n}\n';
  const ri = check(idx, [bin(1, idx, '^=', '|='), bin(2, idx, '+', '-'), bin(3, idx, '+', '*', 1)]);
  assert.equal(line(ri, 2), '    if on(1) { v[i + 1] |= v[i] + 2 } else { v[if on(2) { (i) - (1) } else { (i) + (1) }] ^= if on(3) { (v[i]) * (2) } else { (v[i]) + (2) } };');
});

test('unary ! on a method call', () => {
  const src = 'fn f(s: &str) -> bool {\n    !s.starts_with("x") && s.len() > 1\n}\n';
  const r = check(src, [un(1, src, '!')]);
  assert.equal(line(r, 2), '    (if on(1) { s.starts_with("x") } else { !(s.starts_with("x")) }) && s.len() > 1');
});

test('operators inside strings, raw strings, chars and comments are not operators', () => {
  const src = 'fn f(a: u8, b: u8) -> bool {\n    let s = "a == b"; let r = r#"x == "y" + z"#; let c = \'+\';\n    /* a == b */ a /* + */ == // == b\n        b\n}\n';
  const r = check(src, [bin(1, src, '==', '!=', 3), bin(2, src, '==', '!=', 0), bin(3, src, '+', '-', 0)]);
  assert.deepEqual(r.switched, [1]);
  assert.equal(reason(r, 2), 'span');
  assert.equal(reason(r, 3), 'span');
  assert.equal(line(r, 3), '    /* a == b */ if on(1) { (a) != (b) } else { (a) /* + */ == // == b');
  assert.equal(line(r, 4), '        (b) }');
});

test('operands spanning lines go on one line in the on branch only', () => {
  const src = 'fn f(v: &[u32]) -> u32 {\n    v.iter()\n        .map(|x| x + 1) // add\n        .sum::<u32>()\n        * 2\n}\n';
  const r = check(src, [{ number: 1, genre: 'BinaryOperator', span: at(src, '*', 0, 1), replacement: '/' }]);
  assert.equal(line(r, 2), '    if on(1) { (v.iter() .map(|x| x + 1) .sum::<u32>()) / (2) } else { (v.iter()');
  assert.equal(line(r, 4), '        .sum::<u32>())');
  assert.equal(line(r, 5), '        * (2) }');
});

test('multi-line string literal in an operand is refused', () => {
  const src = 'fn f(s: &str) -> bool {\n    s == "a\n b"\n}\n';
  assert.equal(reason(check(src, [bin(1, src, '==', '!=')]), 1), 'multiline');
});

test('FnValue with a tail expression and with statements', () => {
  const src = 'fn one() -> u32 {\n    1\n}\nfn two(x: u32) -> String {\n    let y = x + 1;\n    format!("{y}")\n}\n';
  const r = check(src, [fnv(1, src, '1', '0'), fnv(2, src, 'let y = x + 1;\n    format!("{y}")', 'String::new()'), fnv(3, src, 'let y = x + 1;\n    format!("{y}")', '"xyzzy".into()'), bin(4, src, '+', '-')]);
  assert.deepEqual(r.switched, [1, 2, 3, 4]);
  assert.equal(line(r, 2), '    if on(1) { return 0; } 1');
  assert.equal(line(r, 5), '    if on(2) { return String::new(); } if on(3) { return "xyzzy".into(); } let y = if on(4) { (x) - (1) } else { (x) + (1) };');
});

test('FnValue on a constructor body with a raw string', () => {
  const src = [
    'use regex::Regex;', '', 'pub struct Pattern {', '    re: Regex,', '}', '', 'impl Pattern {',
    '    pub fn new(s: &str) -> Pattern { Pattern { re: Regex::new(s).unwrap() } }', '}', '', '/// The secret pattern.',
    '#[must_use]', 'pub fn pattern() -> Pattern {', '    // keys look like sk_live_...', '    Pattern::new(r"sk_(live|test)_\\w+")', '}', '',
  ].join('\n');
  const span = { start: { line: 15, column: 5 }, end: { line: 15, column: 35 } };
  assert.equal(src.split('\n')[14].slice(4, 34), 'Pattern::new(r"sk_(live|test)_');
  // a listing span that does not cover the whole body is refused; the full body span is used
  const body = at(src, 'Pattern::new(r"sk_(live|test)_\\w+")');
  const r = check(src, [{ number: 7, genre: 'FnValue', span: body, replacement: 'Default::default()', function: { function_name: 'pattern', return_type: '-> Pattern' } },
    { number: 8, genre: 'FnValue', span, replacement: 'Default::default()' }, { number: 9, genre: 'MatchArm', span: body, replacement: '_' }]);
  assert.deepEqual(r.switched, [7]);
  assert.equal(reason(r, 8), 'span');
  assert.equal(reason(r, 9), 'genre');
  assert.equal(line(r, 15), '    if on(7) { return Default::default(); } Pattern::new(r"sk_(live|test)_\\w+")');
});

test('FnValue refusals: const fn, impl and never returns, inner attributes, bad replacements', () => {
  const src = [
    'const fn c() -> u8 { 1 + 2 }',
    'fn i() -> impl Iterator<Item = u8> { std::iter::empty() }',
    'fn n() -> ! { loop {} }',
    'fn a() -> u8 { #![allow(unused)] 3 }',
    'fn ok() -> u8 { 4 }',
    '',
  ].join('\n');
  const r = check(src, [fnv(1, src, '1 + 2', '0'), bin(2, src, '+', '-'), fnv(3, src, 'std::iter::empty()', 'Default::default()'),
    fnv(4, src, 'loop {}', 'Default::default()'), fnv(5, src, '#![allow(unused)] 3', '0'),
    fnv(6, src, '4', '0 // gone'), fnv(7, src, '4', '{ 1'), fnv(8, src, '4', '1; 2'), fnv(9, src, '4', '1')]);
  assert.deepEqual(r.switched, [9]);
  assert.deepEqual(r.refused.map((x) => [x.number, x.reason]), [[1, 'const'], [2, 'const'], [3, 'return-type'], [4, 'return-type'], [5, 'attribute'],
    [6, 'replacement'], [7, 'replacement'], [8, 'replacement']]);
});

test('const and static items, const blocks, array lengths, const generic args are refused', () => {
  const src = [
    'const A: u32 = 1 + 2;',
    'static B: u32 = 3 * 4;',
    'fn f<const N: usize>(x: u32) -> u32 {',
    '    const C: u32 = 5 - 1;',
    '    let a = [0u8; 2 + 1];',
    '    let b = const { 6 + 7 };',
    '    let c: [u8; N + 1] = [0; N + 1];',
    '    let d = g::<{ N - 1 }>();',
    '    x + a.len() as u32 + b + c.len() as u32 + d as u32',
    '}',
    'fn g<const M: usize>() -> usize { M }',
    '',
  ].join('\n');
  const faults = [bin(1, src, '+', '-'), bin(2, src, '*', '/'), bin(3, src, '-', '+', 1), bin(4, src, '+', '-', 1), bin(5, src, '+', '-', 2),
    bin(6, src, '+', '-', 3), bin(7, src, '+', '-', 4), bin(8, src, '-', '+', 2), bin(9, src, '+', '-', 5)];
  const r = check(src, faults);
  assert.deepEqual(r.switched, [9]);
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.equal(reason(r, n), n === 6 ? 'pattern' : 'const', `fault ${n}`);
  assert.equal(reason(r, 8), 'generic');
});

test('macro token trees and attributes are refused', () => {
  const src = 'fn f(a: u32, b: u32) {\n    assert_eq!(a + b, 3);\n    let v = vec![a * 2];\n    #[allow(unused)]\n    let w = a - b;\n    let z = v.len() as u32 + w;\n}\n';
  const r = check(src, [bin(1, src, '+', '-'), bin(2, src, '*', '/'), bin(3, src, '-', '+'), bin(4, src, '+', '-', 1)]);
  assert.deepEqual(r.refused, [{ number: 1, reason: 'macro' }, { number: 2, reason: 'macro' }, { number: 3, reason: 'attribute' }]);
  assert.equal(line(r, 6), '    let z = if on(4) { (v.len() as u32) - (w) } else { (v.len() as u32) + (w) };');
});

test('patterns are refused; match guards and arm bodies are switched', () => {
  const src = 'fn f(x: i32) -> i32 {\n    match x {\n        -1 => 0,\n        y if y > 3 => y - 3,\n        _ => { -x }\n    }\n}\n';
  const r = check(src, [{ number: 1, genre: 'UnaryOperator', span: sub(src, '-1 =>', 0, 1), replacement: '' }, op(2, src, 'y > 3', 2, 1, '<'),
    op(3, src, 'y - 3', 2, 1, '+'), { number: 4, genre: 'UnaryOperator', span: sub(src, '-x', 0, 1), replacement: '' }]);
  assert.equal(reason(r, 1), 'pattern');
  assert.deepEqual(r.switched, [2, 3, 4]);
  assert.equal(line(r, 4), '        y if (if on(2) { (y) < (3) } else { (y) > (3) }) => if on(3) { (y) + (3) } else { (y) - (3) },');
  assert.equal(line(r, 5), '        _ => { if on(4) { x } else { -(x) } }');
});

test('closures: params are patterns, bodies are expressions', () => {
  const src = 'fn f(v: &[u8]) -> u8 {\n    let g = |a: u8, b: u8| a | b;\n    v.iter().fold(0, |acc, x| g(acc, *x) ^ 1)\n}\n';
  const r = check(src, [op(1, src, 'a | b', 2, 1, '&'), bin(2, src, '^', '|')]);
  assert.equal(line(r, 2), '    let g = |a: u8, b: u8| if on(1) { (a) & (b) } else { (a) | (b) };');
  assert.equal(line(r, 3), '    v.iter().fold(0, |acc, x| if on(2) { (g(acc, *x)) | (1) } else { (g(acc, *x)) ^ (1) })');
});

test('turbofish with commas and casts', () => {
  const src = 'use std::collections::HashMap;\nfn f(x: u8) -> usize {\n    HashMap::<u8, u8>::new().len() + x as usize * 2\n}\n';
  const r = check(src, [bin(1, src, '+', '-'), bin(2, src, '*', '+')]);
  assert.equal(line(r, 3), '    if on(1) { (HashMap::<u8, u8>::new().len()) - (x as usize * 2) } else { (HashMap::<u8, u8>::new().len()) + (if on(2) { (x as usize) + (2) } else { (x as usize) * (2) }) }');
});

test('let-else keeps parentheses; if let scrutinee', () => {
  const src = 'fn f(a: Option<u8>, b: u8) -> u8 {\n    let Some(x) = a.map(|v| v) else { return b - 1 };\n    if let Some(y) = a.and_then(|v| v.checked_add(x)) { y } else { x * b }\n}\n';
  const r = check(src, [op(1, src, 'b - 1', 2, 1, '+'), bin(2, src, '*', '+')]);
  assert.equal(line(r, 2), '    let Some(x) = a.map(|v| v) else { return if on(1) { (b) + (1) } else { (b) - (1) } };');
  assert.equal(line(r, 3), '    if let Some(y) = a.and_then(|v| v.checked_add(x)) { y } else { if on(2) { (x) + (b) } else { (x) * (b) } }');
});

test('same operator with several replacements nests in number order', () => {
  const src = 'fn f(a: i32, b: i32) -> i32 {\n    a + b\n}\n';
  const r = check(src, [bin(2, src, '+', '*'), bin(1, src, '+', '-')]);
  assert.equal(line(r, 2), '    if on(1) { (a) - (b) } else { if on(2) { (a) * (b) } else { (a) + (b) } }');
});

test('Unicode before the span on the same line counts scalar values', () => {
  const src = 'fn f(a: u8, b: u8) -> bool {\n    let s = "é😀"; let t = a < b;\n    t && s.is_empty()\n}\n';
  const r = check(src, [bin(1, src, '<', '>')]);
  assert.equal(r.refused.length, 0);
  assert.equal(line(r, 2), '    let s = "é😀"; let t = if on(1) { (a) > (b) } else { (a) < (b) };');
  // a UTF-16 column (one more because of the surrogate pair) points elsewhere and is refused
  const bad = at(src, '<'); bad.start = { ...bad.start, column: bad.start.column + 1 }; bad.end = { ...bad.end, column: bad.end.column + 1 };
  assert.equal(reason(check(src, [{ number: 2, genre: 'BinaryOperator', span: bad, replacement: '>' }]), 2), 'span');
});

test('CRLF line endings', () => {
  const src = 'fn f(a: u8, b: u8) -> bool {\r\n    a\r\n        != b\r\n}\r\n';
  const r = check(src, [bin(1, src, '!=', '==')]);
  assert.equal(r.text, 'fn f(a: u8, b: u8) -> bool {\r\n    if on(1) { (a) == (b) } else { (a)\r\n        != (b) }\r\n}\r\n');
});

test('nested fn items, impl methods and trait default bodies', () => {
  const src = [
    'trait T { fn d(&self) -> u8 { 1 + 1 } }',
    'struct S;',
    'impl S { pub fn m(&self, a: u8) -> u8 { fn inner(z: u8) -> u8 { z * 3 } inner(a) - 1 } }',
    '',
  ].join('\n');
  const r = check(src, [bin(1, src, '+', '-'), bin(2, src, '*', '/'), op(3, src, 'inner(a) - 1', 9, 1, '+'), fnv(4, src, 'z * 3', '0')]);
  assert.deepEqual(r.switched, [1, 2, 3, 4]);
  assert.equal(line(r, 3), 'impl S { pub fn m(&self, a: u8) -> u8 { fn inner(z: u8) -> u8 { if on(4) { return 0; } if on(2) { (z) / (3) } else { (z) * (3) } } if on(3) { (inner(a)) + (1) } else { (inner(a)) - (1) } } }');
});

test('refusals: genre, bad numbers, column!, unbalanced input, bad spans and operators', () => {
  const src = 'fn f(a: u8) -> u8 { a + 1 }\n';
  const r = check(src, [bin(1, src, '+', '-'), { ...bin(2, src, '+', '-'), genre: 'StructField' }, { ...bin(3, src, '+', '-'), replacement: '+=' },
    { ...bin(4, src, '+', '-'), span: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } } }, { ...bin(5, src, 'a +', '-') }]);
  assert.deepEqual(r.refused, [{ number: 2, reason: 'genre' }, { number: 3, reason: 'replacement' }, { number: 4, reason: 'span' }, { number: 5, reason: 'span' }]);
  const dup = switchFaults(src, [bin(1, src, '+', '-'), bin(1, src, '+', '*'), { ...bin(0, src, '+', '-') }]);
  assert.deepEqual(dup.refused.map((x) => x.reason), ['number', 'number']);
  const col = 'fn f(a: u8) -> u32 { a as u32 + column!() }\n';
  assert.equal(reason(check(col, [bin(1, col, '+', '-')]), 1), 'column');
  const broken = 'fn f(a: u8) -> u8 { a + 1 \n';
  assert.equal(reason(check(broken, [bin(1, broken, '+', '-')]), 1), 'unparsed');
  assert.throws(() => switchFaults(src, [], { path: 'on(1); evil' }), /not a Rust path/);
});

test('genre must match the operator found at the span', () => {
  const src = 'fn f(a: i32) -> i32 { -a - 1 }\n';
  const r = check(src, [{ number: 1, genre: 'UnaryOperator', span: sub(src, 'a - 1', 2, 1), replacement: '' },
    op(2, src, '-a', 0, 1, '+'), { number: 3, genre: 'UnaryOperator', span: sub(src, '-a', 0, 1), replacement: '+' }]);
  assert.deepEqual(r.refused, [{ number: 1, reason: 'operator' }, { number: 2, reason: 'operator' }, { number: 3, reason: 'replacement' }]);
});

test('qualified paths, raw identifiers, labeled breaks, unsafe and async blocks', () => {
  const src = [
    'fn f(r#type: u8) -> u8 {',
    '    let d = <u8 as Default>::default() + r#type;',
    "    let l = 'outer: loop { break 'outer d * 2; };",
    '    let u = unsafe { l - 1 };',
    '    let _f = async move { u ^ 1 };',
    '    u',
    '}', '',
  ].join('\n');
  const r = check(src, [bin(1, src, '+', '-'), bin(2, src, '*', '/'), op(3, src, 'l - 1', 2, 1, '+'), bin(4, src, '^', '|')]);
  assert.deepEqual(r.switched, [1, 2, 3, 4]);
  assert.equal(line(r, 2), '    let d = if on(1) { (<u8 as Default>::default()) - (r#type) } else { (<u8 as Default>::default()) + (r#type) };');
  assert.equal(line(r, 3), "    let l = 'outer: loop { break 'outer if on(2) { (d) / (2) } else { (d) * (2) }; };");
});

test('attributes on one match arm or field refuse only that arm or field', () => {
  const src = 'fn f(x: u8) -> u8 {\n    match x {\n        #[cfg(unix)]\n        0 => x + 1,\n        _ => x - 1,\n    }\n}\n';
  const r = check(src, [bin(1, src, '+', '-'), op(2, src, 'x - 1', 2, 1, '+')]);
  assert.deepEqual(r.refused, [{ number: 1, reason: 'attribute' }]);
  assert.equal(line(r, 5), '        _ => if on(2) { (x) + (1) } else { (x) - (1) },');
  const doc = 'fn g(a: u8) -> u8 {\n    /// odd but legal\n    let b = a + 1;\n    b * 2\n}\n';
  const rd = check(doc, [bin(1, doc, '+', '-'), bin(2, doc, '*', '+')]);
  assert.deepEqual(rd.refused, [{ number: 1, reason: 'attribute' }]);
});

test('block-like statements end at their brace unless . or ? continues them', () => {
  const src = 'fn f(c: bool, v: Vec<u8>) -> usize {\n    if c { () }\n    (1 - 2usize.min(1)) + match c { _ => &v }.len() * 2\n}\n';
  const r = check(src, [op(1, src, '1 - 2', 2, 1, '+'), op(2, src, ') + match', 2, 1, '-'), op(3, src, '.len() * 2', 7, 1, '+')]);
  assert.deepEqual(r.switched, [1]);
  assert.deepEqual(r.refused, [{ number: 2, reason: 'ambiguous' }, { number: 3, reason: 'ambiguous' }]);
  assert.equal(line(r, 3), '    (if on(1) { (1) + (2usize.min(1)) } else { (1) - (2usize.min(1)) }) + match c { _ => &v }.len() * 2');
});

test('closures inside conditions and dereferenced operands', () => {
  const src = 'fn f(v: &[i32]) -> bool {\n    if v.iter().any(|x| *x > 2) { true } else { false }\n}\n';
  const r = check(src, [bin(1, src, '>', '<', 1)]);
  assert.equal(line(r, 2), '    if v.iter().any(|x| if on(1) { (*x) < (2) } else { (*x) > (2) }) { true } else { false }');
});

test('unsure cases are refused: <= right after a cast type', () => {
  const src = 'fn f(x: u32, y: u64) -> bool {\n    let a = x as u64 <= y;\n    let b = (x as u64) <= y;\n    a && b\n}\n';
  const r = check(src, [op(1, src, 'u64 <= y;', 4, 2, '>'), op(2, src, ') <= y', 2, 2, '>')]);
  assert.deepEqual(r.refused, [{ number: 1, reason: 'unparsed' }]);
  assert.equal(line(r, 3), '    let b = if on(2) { (x as u64) > (y) } else { (x as u64) <= (y) };');
});

test('byte order mark and shebang lines', () => {
  const src = '\uFEFF#!/usr/bin/env run-cargo-script\nfn main() { let x = 1 + 2; println!("{x}"); }\n';
  const r = check(src, [bin(1, src, '+', '-')]);
  assert.equal(line(r, 2), 'fn main() { let x = if on(1) { (1) - (2) } else { (1) + (2) }; println!("{x}"); }');
});

test('lexer: chars vs lifetimes, numbers, raw identifiers, nested comments, prefixed strings', () => {
  const t = (s) => lexRust(s).map((x) => x.v);
  assert.deepEqual(t("'a' '\\n' '\\u{1F600}' 'a 'static '\\'' 'é'"), ["'a'", "'\\n'", "'\\u{1F600}'", "'a", "'static", "'\\''", "'é'"]);
  assert.deepEqual(t('1_000 0xff 1e-3 2.5f64 1u8 1..2 1.0..2.0 x.0.1 1.max(2) 0b1010_u8'), ['1_000', '0xff', '1e-3', '2.5f64', '1u8', '1', '.', '.', '2', '1.0', '.', '.', '2.0', 'x', '.', '0.1', '1', '.', 'max', '(', '2', ')', '0b1010_u8']);
  assert.deepEqual(t('r#type /* a /* b */ c */ x // y\nz'), ['r#type', 'x', 'z']);
  assert.deepEqual(t('b"a\\"b" br#"x"# c"z" cr"w" b\'q\' r##"a "# b"##'), ['b"a\\"b"', 'br#"x"#', 'c"z"', 'cr"w"', "b'q'", 'r##"a "# b"##']);
  assert.deepEqual(lexRust('/// doc\n//! inner\n/** d */ /*! e */ /**/ /***/ x').map((x) => x.k), ['doc', 'doc', 'doc', 'doc', 'id']);
  const p = lexRust('a >>= b > > c');
  assert.deepEqual(p.filter((x) => x.k === 'p').map((x) => [x.v, x.j]), [['>', true], ['>', true], ['=', false], ['>', false], ['>', false]]);
  assert.doesNotThrow(() => lexRust('"unterminated \u0000 \'\' ` ¿'));
});

test('rustc: the rewritten program behaves like the original with switches off', { skip: !hasRustc() && 'rustc not on PATH' }, () => {
  const src = [
    '#![deny(warnings)]',
    'fn add(a: i32, b: i32) -> i32 { a + b * 2 }',
    'fn is_big(v: &[i32]) -> bool { v.len() > 2 && !v.is_empty() }',
    'fn neg(x: i32) -> i64 { -x as i64 + 1 }',
    'fn total(xs: &[i32]) -> i32 {',
    '    let mut t = 0;',
    '    for x in xs { t += x; }',
    '    t',
    '}',
    'fn name() -> String { String::from("abc") }',
    'fn pick(x: Option<i32>) -> i32 {',
    '    match x { Some(y) if y > 1 => y - 1, Some(y) => -y, None => 0 }',
    '}',
    'struct P { a: i32 }',
    'fn r(a: i32) -> i32 { if a > 100 { return 0; } return a * 3; }',
    'fn sites(a: i32, b: i32, v: &mut Vec<i32>) -> String {',
    '    let mut i = 0;',
    '    while i < a { i += 2; }',
    '    let mut s = 0;',
    '    for x in 0..a { s += x; }',
    '    let g = |x: i32, y: i32| x | y;',
    '    let true = a > 0 else { return String::new() };',
    '    let Some(h) = v.first().copied() else { return String::new() };',
    '    let p = P { a: a + 1 };',
    '    let t = (a - 1, b);',
    '    let arr = [a + 2, 2];',
    '    v[1] ^= h + 4;',
    '    let m = (a + b).max(3);',
    '    let c = (a * 2) as u64;',
    '    let k = (a + b) * 2;',
    '    let y: i32;',
    '    y = a * b;',
    '    let q = if let Some(z) = v.get(0) { *z - 1 } else { 0 };',
    '    let neg = -1;',
    '    let mm = match a + b { 7 => 1, _ => 0 };',
    '    let il = if let 7 = a - -b { 1 } else { 0 };',
    '    let ix = [5, 6, 7][a as usize - 3];',
    '    let ab = i32::abs(a - 5);',
    '    format!("{} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {}", i, s, g(a, b), p.a, t.0, arr[0], v[1], m, c, k, y, q, neg, h, r(a), mm, il, ix, ab)',
    '}',
    'fn main() {',
    '    println!("{}", sites(3, 4, &mut vec![10, 20, 30]));',
    '    let v = vec![1, 2, 3];',
    '    let s: i32 = v.iter().map(|x| x * 3).sum::<i32>();',
    '    println!("{} {} {} {} {} {}", add(2, 3), is_big(&v), neg(5), total(&v), name(), s);',
    '    if add(1, 1) == 5 { println!("eq"); } else { println!("ne {}", pick(Some(4)) + pick(Some(1))); }',
    '}',
    '',
  ].join('\n');
  const faults = [
    op(1, src, 'a + b * 2', 2, 1, '-'), op(2, src, 'b * 2', 2, 1, '/'), op(3, src, 'v.len() > 2', 8, 1, '<'), op(4, src, '2 && !', 2, 2, '||'),
    { number: 5, genre: 'UnaryOperator', span: sub(src, '!v.is_empty', 0, 1), replacement: '' },
    { number: 6, genre: 'UnaryOperator', span: sub(src, '-x as', 0, 1), replacement: '' },
    op(7, src, 'i64 + 1', 4, 1, '-'), op(8, src, 't += x', 2, 2, '-='),
    { number: 9, genre: 'FnValue', span: sub(src, 'String::from("abc")'), replacement: 'String::new()' },
    op(10, src, 'y > 1', 2, 1, '<'), op(11, src, 'y - 1', 2, 1, '+'),
    { number: 12, genre: 'UnaryOperator', span: sub(src, '=> -y', 3, 1), replacement: '' },
    op(13, src, 'x * 3', 2, 1, '+'), op(14, src, '== 5', 0, 2, '!='),
    { number: 15, genre: 'FnValue', span: sub(src, 'let mut t = 0;\n    for x in xs { t += x; }\n    t'), replacement: '1' },
    op(20, src, 'i < a', 2, 1, '>'), op(21, src, 's += x', 2, 2, '-='), op(22, src, 'x | y', 2, 1, '&'), op(23, src, 'a: a + 1', 5, 1, '*'),
    op(24, src, 'a - 1, b', 2, 1, '/'), op(25, src, 'a + 2, 2', 2, 1, '-'), op(26, src, '^= h', 0, 2, '|='), op(27, src, '(a + b).max', 3, 1, '*'),
    op(28, src, 'a * 2) as', 2, 1, '+'), op(29, src, '(a + b) * 2', 3, 1, '-'), op(30, src, '(a + b) * 2', 8, 1, '/'), op(31, src, 'y = a * b', 6, 1, '+'),
    op(32, src, '*z - 1', 3, 1, '+'), { number: 33, genre: 'UnaryOperator', span: sub(src, 'neg = -1', 6, 1), replacement: '' },
    op(34, src, 'a * 3', 2, 1, '+'), op(35, src, 'a > 0 else', 2, 1, '<'),
    op(36, src, 'match a + b', 8, 1, '-'), op(37, src, 'a - -b', 2, 1, '*'), { number: 38, genre: 'UnaryOperator', span: sub(src, 'a - -b', 4, 1), replacement: '' },
    op(39, src, 'usize - 3', 6, 1, '/'), op(40, src, 'abs(a - 5)', 6, 1, '+'),
  ];
  const r = check(src, faults, 'crate::__cupel_faults::on');
  assert.deepEqual(r.refused, []);
  const dir = mkdtempSync(join(tmpdir(), 'cupel-schemata-'));
  try {
    const build = (name, code) => {
      const file = join(dir, `${name}.rs`); writeFileSync(file, code);
      const binary = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
      const out = spawnSync('rustc', ['--edition', '2021', '--crate-type', 'bin', '-o', binary, file], { encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
      return (fault) => spawnSync(binary, [], { encoding: 'utf8', env: { ...process.env, CUPEL_FAULT: String(fault) } }).stdout;
    };
    const original = build('orig', src);
    const switched = build('switched', `${r.text}\n${FAULT_MODULE}\n`);
    const base = original(0);
    const head = (fields) => `${fields.join(' ')}\n`;
    const b2 = [4, 3, 7, 4, 2, 5, 26, 7, 6, 14, 12, 9, -1, 10, 9, 1, 1, 5, 2];
    const with2 = (k, val) => head(b2.map((x, j) => (j === k ? val : x)));
    assert.equal(base, `${head(b2)}8 true -4 6 abc 18\nne 2\n`);
    assert.equal(switched(0), base);
    assert.equal(switched('junk'), base);
    const rest = '8 true -4 6 abc 18\nne 2\n';
    const second = {
      20: with2(0, 0), 21: with2(1, -3), 22: with2(2, 0), 23: with2(3, 3), 24: with2(4, 3), 25: with2(5, 1), 26: with2(6, 30), 27: with2(7, 12),
      28: with2(8, 5), 29: with2(9, -2), 30: with2(9, 3), 31: with2(10, 7), 32: with2(11, 11), 33: with2(12, 1), 34: with2(14, 6), 35: '\n',
      36: with2(15, 0), 37: with2(16, 0), 38: with2(16, 0), 39: with2(17, 6), 40: with2(18, 8),
    };
    for (const [n, want] of Object.entries(second)) assert.equal(switched(n), want + rest, `fault ${n}`);
    const expected = {
      1: '-4 true -4 6 abc 18\nne 2\n', 2: '3 true -4 6 abc 18\nne 2\n', 3: '8 false -4 6 abc 18\nne 2\n', 4: rest,
      5: '8 false -4 6 abc 18\nne 2\n', 6: '8 true 6 6 abc 18\nne 2\n', 7: '8 true -6 6 abc 18\nne 2\n', 8: '8 true -4 -6 abc 18\nne 2\n',
      9: '8 true -4 6  18\nne 2\n', 10: '8 true -4 6 abc 18\nne -5\n', 11: '8 true -4 6 abc 18\nne 4\n', 12: '8 true -4 6 abc 18\nne 4\n',
      13: '8 true -4 6 abc 15\nne 2\n', 14: '8 true -4 6 abc 18\neq\n', 15: '8 true -4 1 abc 18\nne 2\n',
    };
    for (const [n, want] of Object.entries(expected)) assert.equal(switched(n), head(b2) + want, `fault ${n}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function hasRustc() {
  try { return spawnSync('rustc', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}
