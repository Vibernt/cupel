// Windows path handling, checked on every OS by naming the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../src/cli/shell-quote.mjs';
import { splitCommand } from '../src/collect/vitest/index.mjs';
import { isFileFailure } from '../src/mutate/runner.mjs';

test('commands are quoted for /bin/sh on POSIX and for cmd.exe on Windows', () => {
  assert.equal(quote("it's here", 'linux'), `'it'"'"'s here'`);
  assert.equal(quote('D:\\a\\my project\\in.json', 'win32'), '"D:\\a\\my project\\in.json"');
  assert.throws(() => quote('D:\\100%', 'win32'), /cmd\.exe/);
  assert.throws(() => quote('say "hi"', 'win32'), /cmd\.exe/);
  assert.throws(() => ['id'].map(quote), /platform must be a string/);
});

test('a configured Vitest command keeps Windows backslashes; on POSIX a backslash escapes', () => {
  assert.deepEqual(splitCommand('"C:\\hostedtoolcache\\node.exe" D:\\a\\vitest.mjs', 'win32'),
    ['C:\\hostedtoolcache\\node.exe', 'D:\\a\\vitest.mjs']);
  assert.deepEqual(splitCommand('node my\\ dir/vitest.mjs', 'linux'), ['node', 'my dir/vitest.mjs']);
  assert.deepEqual(splitCommand("'C:\\a b\\node.exe' run", 'win32'), ['C:\\a b\\node.exe', 'run']);
});

test('a test file that failed to load is recognised by any name node:test gives it, and nothing else is', () => {
  const file = 'tests/calc.test.mjs';
  for (const t of [file, 'calc.test.mjs', 'tests\\calc.test.mjs', 'D:\\a\\project\\tests\\calc.test.mjs', 'file:///D:/a/project/tests/calc.test.mjs']) {
    assert.equal(isFileFailure(file, { s: 'fail', t }), true, t);
  }
  for (const t of ['suite > tests/calc.test.mjs', '/abs/tests/calc.test.mjs', 'D:\\a\\other-tests\\calc.test.mjs']) {
    assert.equal(isFileFailure(file, { s: 'fail', t }), false, t);
  }
  assert.equal(isFileFailure(file, { s: 'fail', t: file, suite: true }), false);
});
