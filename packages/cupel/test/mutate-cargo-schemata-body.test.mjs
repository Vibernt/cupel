import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyVariants } from '../src/mutate-cargo/schemata-body.mjs';
import { FAULT_MODULE, lexRust } from '../src/mutate-cargo/schemata.mjs';

function spanAt(text, needle, occurrence = 0, length = needle.length) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(needle, offset + 1);
    if (offset < 0) throw new Error(`missing ${needle} #${occurrence}`);
  }
  const position = (at) => {
    const before = text.slice(0, at);
    const lineStart = before.lastIndexOf('\n') + 1;
    return { line: before.split('\n').length, column: [...text.slice(lineStart, at)].length + 1 };
  };
  return { start: position(offset), end: position(offset + length) };
}

const fault = (number, text, needle, replacement, occurrence = 0) => ({
  number,
  genre: 'BinaryOperator',
  span: spanAt(text, needle, occurrence),
  replacement,
});

function delimiterMatches(tokens) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].k === 'o') stack.push(index);
    if (tokens[index].k === 'c') {
      const open = stack.pop();
      assert.equal(tokens[index].v, pairs[tokens[open].v]);
      tokens[open].m = index;
    }
  }
  assert.equal(stack.length, 0);
}

function withoutVariants(text, path = 'crate::__cupel_faults::active') {
  const tokens = lexRust(text);
  delimiterMatches(tokens);
  const pathTokens = lexRust(path).map((token) => token.v);
  const ranges = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].v !== 'match') continue;
    if (!pathTokens.every((value, part) => tokens[index + 1 + part]?.v === value)) continue;
    const call = index + 1 + pathTokens.length;
    if (tokens[call]?.v !== '(' || tokens[tokens[call].m + 1]?.v !== '{') continue;
    const body = tokens[call].m + 1;
    ranges.push([tokens[index].s, tokens[tokens[body].m].e]);
  }
  let stripped = text;
  for (const [start, end] of ranges.reverse()) stripped = stripped.slice(0, start) + stripped.slice(end);
  return stripped;
}

function reason(result, number) {
  return result.refused.find((entry) => entry.number === number)?.reason;
}

test('renders an exact whole-body variant for a regrouping && fault', () => {
  const source = 'fn all(a: bool, b: bool, c: bool, d: bool) -> bool {\n    a && b && c && d\n}\n';
  const result = bodyVariants(source, [fault(7, source, '&&', '||', 1)]);
  assert.deepEqual(result.switched, [7]);
  assert.deepEqual(result.refused, []);
  assert.equal(result.text.split('\n')[0], 'fn all(a: bool, b: bool, c: bool, d: bool) -> bool {match crate::__cupel_faults::active() { 7 => return { a && b || c && d }, _ => {} }');
  assert.equal(result.text.split('\n').length, source.split('\n').length);
  assert.deepEqual(lexRust(withoutVariants(result.text)).map((token) => token.v), lexRust(source).map((token) => token.v));
});

test('drops comments only in variants and leaves the original token stream intact', () => {
  const source = 'fn f(a: i32, b: i32) -> i32 { // body\n    a /* left */ + // operator\n    b\n}\n';
  const result = bodyVariants(source, [fault(1, source, '+', '*')], { path: 'active' });
  assert.equal(result.text.split('\n')[0], 'fn f(a: i32, b: i32) -> i32 {match active() { 1 => return { a * b }, _ => {} } // body');
  assert.equal(result.text.split('\n').length, source.split('\n').length);
  assert.deepEqual(lexRust(withoutVariants(result.text, 'active')).map((token) => token.v), lexRust(source).map((token) => token.v));
});

test('accepts method bodies including self shorthand', () => {
  const source = 'struct S { n: i32 }\nimpl S { fn changed(&self) -> Self { let _p = &self.n as *const i32; let _c = const { 1 }; Self { n: self.n + 1 } } }\n';
  const result = bodyVariants(source, [fault(1, source, '+', '*')]);
  assert.deepEqual(result.switched, [1]);
  assert.match(result.text, /return \{ .*Self \{ n: self\.n \* 1 \} \}/);
});

test('refuses const, async, opaque and never-returning functions', () => {
  const source = [
    'const fn c() -> i32 { 1 + 2 }',
    'async fn a() -> i32 { 3 + 4 }',
    'fn i() -> impl Iterator<Item = i32> { [5 + 6].into_iter() }',
    'fn n() -> ! { panic!("x"); 7 + 8 }',
    '',
  ].join('\n');
  const result = bodyVariants(source, [
    fault(1, source, '+', '-', 0), fault(2, source, '+', '-', 1),
    fault(3, source, '+', '-', 2), fault(4, source, '+', '-', 3),
  ]);
  assert.deepEqual(result.refused, [
    { number: 1, reason: 'const' }, { number: 2, reason: 'async' },
    { number: 3, reason: 'return-type' }, { number: 4, reason: 'return-type' },
  ]);
});

test('refuses every nested item kind', () => {
  const items = [
    'fn nested() {}', 'struct X;', 'enum X {}', 'impl X {}', 'trait X {}', 'mod x {}',
    'static X: i32 = 0;', 'const X: i32 = 0;', 'use x::X;', 'macro_rules! x { () => {} }', 'type X = i32;',
  ];
  for (const [index, item] of items.entries()) {
    const source = `fn f() -> i32 { ${item} 1 + 2 }\n`;
    const result = bodyVariants(source, [fault(index + 1, source, '+', '-')]);
    assert.equal(reason(result, index + 1), 'item', item);
  }
});

test('refuses source-position macros and multiline literals', () => {
  const position = 'fn f() -> u32 { let _ = (line!(), column!(), file!()); 1 + 2 }\n';
  assert.equal(reason(bodyVariants(position, [fault(1, position, '+', '-')]), 1), 'macro');

  const macro = 'fn f() -> i32 { m!(\n"a\nb"\n); 1 + 2 }\n';
  assert.equal(reason(bodyVariants(macro, [fault(2, macro, '+', '-')]), 2), 'macro');

  for (const [index, literal] of ['"a\nb"', "'\n'", 'b"a\nb"'].entries()) {
    const source = `fn f() -> i32 { let _ = ${literal}; 1 + 2 }\n`;
    assert.equal(reason(bodyVariants(source, [fault(index + 3, source, '+', '-')]), index + 3), 'multiline');
  }
});

test('refuses inner attributes and bodies over the byte budget', () => {
  const attribute = 'fn f() -> i32 { #![allow(unused)] 1 + 2 }\n';
  assert.equal(reason(bodyVariants(attribute, [fault(1, attribute, '+', '-')]), 1), 'attribute');

  const plain = 'fn f() -> i32 { 1 + 2 }\n';
  assert.deepEqual(bodyVariants(plain, [fault(2, plain, '+', '-')], { budget: 5 }).switched, [2]);
  assert.equal(reason(bodyVariants(plain, [fault(3, plain, '+', '-')], { budget: 4 }), 3), 'budget');

  const generic = 'fn f<T>() -> i32 { 1 + 2 }\n';
  assert.equal(reason(bodyVariants(generic, [fault(4, generic, '+', '-')], { budget: 5 }), 4), 'budget');
  assert.deepEqual(bodyVariants(generic, [fault(5, generic, '+', '-')], { budget: 10 }).switched, [5]);
});

test('bounds each function at eight accepted faults', () => {
  const source = 'fn f() -> i32 { 1 + 2 }\n';
  const faults = Array.from({ length: 10 }, (_, index) => fault(index + 1, source, '+', index % 2 ? '*' : '-'));
  const result = bodyVariants(source, faults);
  assert.deepEqual(result.switched, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(result.refused, [{ number: 9, reason: 'bound' }, { number: 10, reason: 'bound' }]);
});

test('requires a fault span to be inside exactly one function body', () => {
  const source = 'const X: i32 = 1 + 2;\nfn outer() -> i32 { fn inner() -> i32 { 3 + 4 } 5 + 6 }\n';
  const result = bodyVariants(source, [
    fault(1, source, '+', '-', 0), fault(2, source, '+', '-', 1), fault(3, source, '+', '-', 2),
  ]);
  assert.equal(reason(result, 1), 'function');
  assert.equal(reason(result, 2), 'function');
  assert.equal(reason(result, 3), 'item');
});

test('rustc parity: each text mutant equals its selected body variant', { skip: !hasRustc() && 'rustc not on PATH' }, () => {
  const source = [
    'fn values(a: bool, b: bool, c: bool, d: bool, x: i32, y: i32, z: i32) -> (bool, i32, i32) {',
    '    (a && b && c && d, x + y + z, x - y - z)',
    '}',
    'fn main() { println!("{:?}", values(true, false, true, true, 20, 5, 3)); }',
    '',
  ].join('\n');
  const faults = [
    fault(1, source, '&&', '||', 1),
    fault(2, source, '+', '*', 1),
    fault(3, source, '-', '/', 1),
  ];
  const variants = bodyVariants(source, faults);
  assert.deepEqual(variants.refused, []);

  const scratch = join(process.cwd(), '.scratch');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'schemata-body-'));
  try {
    const build = (name, code) => {
      const rust = join(directory, `${name}.rs`);
      const binary = join(directory, name);
      writeFileSync(rust, code);
      const compiled = spawnSync('rustc', ['--edition', '2021', '-O', '-o', binary, rust], { encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr);
      return binary;
    };
    const run = (binary, selected) => {
      const env = { ...process.env };
      delete env.CUPEL_FAULT;
      if (selected !== undefined) env.CUPEL_FAULT = String(selected);
      const result = spawnSync(binary, [], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const original = build('original', source);
    const switched = build('switched', `${variants.text}\n${FAULT_MODULE}\n`);
    assert.equal(run(switched), run(original));

    for (const entry of faults) {
      const start = offsetFor(source, entry.span.start);
      const end = offsetFor(source, entry.span.end);
      const individual = build(`fault_${entry.number}`, source.slice(0, start) + entry.replacement + source.slice(end));
      assert.equal(run(switched, entry.number), run(individual), `fault ${entry.number}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function offsetFor(text, position) {
  const lines = text.split('\n');
  let offset = 0;
  for (let line = 1; line < position.line; line++) offset += lines[line - 1].length + 1;
  let column = 1;
  while (column < position.column) {
    offset += text.codePointAt(offset) > 0xffff ? 2 : 1;
    column++;
  }
  return offset;
}

function hasRustc() {
  try { return spawnSync('rustc', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}
