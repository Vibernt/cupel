import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli/main.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';

test('CLI help distinguishes first-release core, native previews and private selection', async () => {
  let output = '';
  const exit = await main(['--help'], { cwd: process.cwd(), env: {}, colour: false,
    out: value => { output += value; }, err: value => assert.fail(value) });
  assert.equal(exit, 0);
  assert.match(output, /JS\/TS\/Python ordinary full guard/);
  assert.match(output, /bounded Go\/Ruby\/Rust previews/);
  assert.match(output, /Selective PR commands are private experiments outside the supported first release/);
  for (const command of ['pr-producer', 'pr-prepare', 'pr'])
    assert.match(output, new RegExp(`\\n  ${command}\\s+experimental:`));
  for (const command of ['collect-go', 'collect-cargo'])
    assert.match(output, new RegExp(`\\n  ${command}\\s+preview:`));
});

test('MCP metadata preserves the same release boundary without removing private tools', () => {
  for (const name of ['cupel_report', 'cupel_guard']) {
    const tool = TOOLS.find(value => value.name === name);
    assert.match(tool.description, /core is JS\/TS\/Python/);
    assert.match(tool.description, /Go\/Ruby\/Rust are previews/);
  }
  for (const name of ['cupel_pr_producer', 'cupel_pr_prepare', 'cupel_pr']) {
    const tool = TOOLS.find(value => value.name === name);
    assert.match(tool.description, /Private experiment outside the supported first release/);
  }
});
