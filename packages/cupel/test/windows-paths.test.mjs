// Windows path handling, checked on every OS by naming the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../src/cli/shell-quote.mjs';
import { splitCommand } from '../src/collect/vitest/index.mjs';

test('commands are quoted for /bin/sh on POSIX and for cmd.exe on Windows', () => {
  assert.equal(quote("it's here", 'linux'), `'it'"'"'s here'`);
  assert.equal(quote('D:\\a\\my project\\in.json', 'win32'), '"D:\\a\\my project\\in.json"');
  assert.throws(() => quote('D:\\100%', 'win32'), /cmd\.exe/);
  assert.throws(() => quote('say "hi"', 'win32'), /cmd\.exe/);
});

test('a configured Vitest command keeps Windows backslashes; on POSIX a backslash escapes', () => {
  assert.deepEqual(splitCommand('"C:\\hostedtoolcache\\node.exe" D:\\a\\vitest.mjs', 'win32'),
    ['C:\\hostedtoolcache\\node.exe', 'D:\\a\\vitest.mjs']);
  assert.deepEqual(splitCommand('node my\\ dir/vitest.mjs', 'linux'), ['node', 'my dir/vitest.mjs']);
  assert.deepEqual(splitCommand("'C:\\a b\\node.exe' run", 'win32'), ['C:\\a b\\node.exe', 'run']);
});
