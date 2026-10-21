import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/lang/js/lexer.mjs';

const kinds = (src, opts) => tokenize(src, opts).map((t) => `${t.type}:${t.value}`);

test('operators use longest match', () => {
  assert.deepEqual(kinds('a === b ?? c?.d'), ['name:a', 'punct:===', 'name:b', 'punct:??', 'name:c', 'punct:?.', 'name:d']);
});

test('a slash after an expression is division, after an operator a regex', () => {
  assert.deepEqual(kinds('x = a / b'), ['name:x', 'punct:=', 'name:a', 'punct:/', 'name:b']);
  assert.deepEqual(kinds('x = /a+/g'), ['name:x', 'punct:=', 'regex:/a+/g']);
  assert.deepEqual(kinds('return /x/.test(s)').slice(0, 2), ['name:return', 'regex:/x/']);
});

test('strings, templates and comments are never split into tokens', () => {
  assert.deepEqual(kinds("'a < b' // c > d"), ["string:'a < b'"]);
  assert.deepEqual(kinds('`a ${b} c`').map((k) => k.split(':')[0]), ['template', 'name', 'template']);
  assert.deepEqual(kinds('/* x */ y', { comments: true }), ['comment:/* x */', 'name:y']);
});

test('tokens carry 1-based lines', () => {
  assert.deepEqual(tokenize('a\nb\n\nc').map((t) => t.line), [1, 2, 4]);
});

test('an unterminated string is a LexError', () => {
  assert.throws(() => tokenize("'abc"), LexError);
});
