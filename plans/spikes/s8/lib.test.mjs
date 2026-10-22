import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { definitionsFromDiff, lineCount, matchIds, parseTitle, shQuote, usageFromLog } from './lib.mjs';

test('new definitions are taken only from added test calls, with their file', () => {
  const diff = "+++ b/tests/one.test.mjs\n+test('a\\'s case', () => {})\n+assert.ok(/x/.test(y))\n-test('old', () => {})\n+++ b/tests/two.test.mjs\n+  it(\"second\", () => {})";
  assert.deepEqual(definitionsFromDiff(diff), [
    { file: 'tests/one.test.mjs', name: "a's case" },
    { file: 'tests/two.test.mjs', name: 'second' },
  ]);
  assert.throws(() => parseTitle("+test('unclosed"), /unclosed test title/);
});

test('collector titles must resolve to exactly one id', () => {
  const tests = [{ id: 'tests/a.test.mjs::new', file: 'tests/a.test.mjs' }];
  assert.deepEqual(matchIds([{ file: 'tests/a.test.mjs', name: 'new' }], tests), ['tests/a.test.mjs::new']);
  assert.throws(() => matchIds([{ file: 'tests/a.test.mjs', name: 'missing' }], tests), /expected one/);
});

test('added lines in untracked files do not count a trailing empty line', () => {
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount(''), 0);
});

test('usage sums completed turns only', () => {
  const dir = mkdtempSync(join(tmpdir(), 's8-test-'));
  try {
    const path = join(dir, 'codex.jsonl');
    writeFileSync(path, [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
      JSON.stringify({ type: 'item.completed', usage: { input_tokens: 100 } }),
      JSON.stringify({ type: 'item.started', item: { id: 'a', type: 'mcp_tool_call', tool: 'cupel_check' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'mcp_tool_call', tool: 'cupel_check' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }),
    ].join('\n'));
    assert.deepEqual(usageFromLog(path), { completedTurns: 2, inputTokens: 14, outputTokens: 5, cupelCheckCalls: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shell quoting retains an apostrophe in a path', () => {
  assert.equal(shQuote("a'b"), "'a'\\''b'");
});
