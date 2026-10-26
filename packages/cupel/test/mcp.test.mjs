import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../src/engine/index.mjs';
import { loadSchemas } from '../src/cli/context.mjs';
import { changedLines } from '../src/cli/git.mjs';

const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CASES = fileURLToPath(new URL('../../../spec/conformance/cases/', import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const casePath = (number, file) => {
  const names = { 9: '009-label-unknown-tag', 18: '018-consolidate-same-shape', 34: '034-plan-changed', 35: '035-check-no-unique-evidence', 40: '040-guard-pass', 41: '041-guard-coverage-lost', 46: '046-guard-critical-removed-approved', 48: '048-guard-runtime-mismatch', 64: '064-review-basic-pack', 74: '074-review-assertion-sidecar' };
  return `${CASES}${names[number]}/${file}.json`;
};

// One child for the suite. Every stdout line is parsed, so stray logging fails immediately.
const child = spawn(process.execPath, [BIN, 'mcp', '--root', ROOT], {
  cwd: tmpdir(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
const replies = [];
const pending = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (text) => { stderr += text; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  let end;
  while ((end = stdout.indexOf('\n')) !== -1) {
    const line = stdout.slice(0, end);
    stdout = stdout.slice(end + 1);
    const response = JSON.parse(line);
    const next = pending.shift();
    if (next) next(response);
    else replies.push(response);
  }
});
child.on('exit', (code) => {
  while (pending.length) pending.shift()({ error: { message: `server exited ${code}: ${stderr}` } });
});
after(async () => {
  child.stdin.end();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(child.exitCode, 0, stderr);
  assert.equal(stdout, '', 'stdout ends at a JSON line boundary');
});

let nextId = 0;
function send(method, params = {}) {
  const id = ++nextId;
  const response = new Promise((resolve) => {
    if (replies.length) resolve(replies.shift());
    else pending.push(resolve);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return response;
}
function raw(line) {
  const response = new Promise((resolve) => {
    if (replies.length) resolve(replies.shift());
    else pending.push(resolve);
  });
  child.stdin.write(`${line}\n`);
  return response;
}
async function call(name, args) {
  const message = await send('tools/call', { name, arguments: args });
  assert.equal(message.error, undefined, JSON.stringify(message));
  const result = message.result;
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'text');
  assert.equal(result.content[0].text.includes('\n'), false);
  assert.equal(result.content[1].text.includes('\n'), false);
  return { result, json: JSON.parse(result.content[1].text) };
}

test('initialize negotiates both supported versions and newest for an unknown version', async () => {
  for (const version of ['2025-06-18', '2025-03-26', '2099-01-01']) {
    const reply = await send('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(reply.result.protocolVersion, version === '2099-01-01' ? '2025-06-18' : version);
    assert.deepEqual(reply.result.capabilities, { tools: {} });
    assert.deepEqual(reply.result.serverInfo, { name: 'cupel', version: read(`${ROOT}packages/cupel/package.json`).version });
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.deepEqual((await send('ping')).result, {});
});

test('without --root, mcp selects the enclosing git root', () => {
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cupel_report', arguments: { input: 'spec/conformance/cases/018-consolidate-same-shape/input.json' } } };
  const result = spawnSync(process.execPath, [BIN, 'mcp'], {
    cwd: `${ROOT}packages/cupel`, input: `${JSON.stringify(message)}\n`, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const report = JSON.parse(JSON.parse(lines[0]).result.content[1].text);
  assert.equal(report.suite.units, 4);
});

test('tools/list describes all tools with object input schemas', async () => {
  const { tools } = (await send('tools/list')).result;
  assert.deepEqual(tools.map((tool) => tool.name), ['cupel_check', 'cupel_report', 'cupel_review', 'cupel_guard', 'cupel_plan', 'cupel_label', 'cupel_pr_producer', 'cupel_pr_prepare', 'cupel_pr']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    if (tool.name === 'cupel_review') {
      assert.match(tool.description, /read the test code.*cupel_guard.*never advises removal/);
    } else if (tool.name.startsWith('cupel_pr')) {
      assert.ok(tool.description.includes('Cupel never advises removing tests'));
      assert.match(tool.description, /pin|pinned/);
    } else {
      assert.ok(tool.description.includes('Cupel never advises removing tests'));
      assert.ok(tool.description.includes('no-unique-evidence means a person may review, never delete'));
    }
    assert.ok(tool.inputSchema.properties);
  }
});

test('review returns the full filtered pack and assertion observations', async () => {
  const args = { units: ['tests/n.test.mjs'], limit: 1 };
  const expected = run('review', { input: read(casePath(64, 'input')) }, {}, args, loadSchemas());
  const { json, result } = await call('cupel_review', { input: casePath(64, 'input'), ...args });
  assert.equal(result.isError, false);
  assert.deepEqual(json, expected.report);
  const sidecar = read(casePath(74, 'assertions'));
  const withAssertions = await call('cupel_review', { input: casePath(74, 'input'), assertions: casePath(74, 'assertions') });
  assert.deepEqual(withAssertions.json, run('review', { input: read(casePath(74, 'input')), assertions: sidecar }, {}, {}, loadSchemas()).report);
});

test('report and label match run, including exit 1 as a normal result', async () => {
  const reportInput = read(casePath(18, 'input'));
  const full = run('report', { input: reportInput }, {}, {}, loadSchemas()).report;
  const report = await call('cupel_report', { input: casePath(18, 'input'), pageSize: 200 });
  assert.equal(report.result.isError, false);
  assert.deepEqual(report.json, { suite: full.suite, units: full.units, groups: full.groups, page: 1, pages: 1 });

  const labelled = run('label', { input: read(casePath(9, 'input')) }, {}, {}, loadSchemas());
  const label = await call('cupel_label', { input: casePath(9, 'input') });
  assert.equal(labelled.exit, 1);
  assert.equal(label.result.isError, false);
  assert.match(label.result.content[0].text, /failed/);
  assert.deepEqual(label.json, { suite: labelled.report.suite, units: labelled.report.units, groups: labelled.report.groups, page: 1, pages: 1 });
});

test('check, guard and plan match run on conformance inputs', async () => {
  const checkArgs = read(casePath(35, 'case')).args;
  const checked = run('check', { input: read(casePath(35, 'input')) }, {}, checkArgs, loadSchemas());
  const check = await call('cupel_check', { input: casePath(35, 'input'), tests: checkArgs.tests });
  assert.equal(checked.exit, 0);
  assert.equal(check.result.isError, false);
  assert.deepEqual(check.json, checked.report);

  for (const number of [40, 41]) {
    const expected = run('guard', { base: read(casePath(number, 'base')), head: read(casePath(number, 'head')) }, {}, {}, loadSchemas());
    const guard = await call('cupel_guard', { baseInput: casePath(number, 'base'), headInput: casePath(number, 'head') });
    assert.equal(guard.result.isError, false);
    assert.deepEqual(guard.json, expected.report);
    assert.equal(guard.json.guard.pass, number === 40);
  }

  const changed = changedLines(ROOT, 'HEAD');
  const config = read(casePath(34, 'config'));
  const expected = run('plan', { input: read(casePath(34, 'input')) }, config, { changed }, loadSchemas());
  const plan = await call('cupel_plan', { input: casePath(34, 'input'), config: casePath(34, 'config'), changed: 'HEAD' });
  assert.equal(plan.result.isError, false);
  assert.deepEqual(plan.json, expected.report);
});

test('check defaults to all input units; guard accepts person-supplied approvals', async () => {
  const input = read(casePath(35, 'input'));
  const tests = [...new Set(input.tests.map((t) => t.unit ?? t.id))].sort();
  const expectedCheck = run('check', { input }, {}, { tests }, loadSchemas());
  const checked = await call('cupel_check', { input: casePath(35, 'input') });
  assert.deepEqual(checked.json, expectedCheck.report);
  assert.equal(checked.result.isError, false);

  const approvals = read(casePath(46, 'case')).args.approvals;
  const expectedGuard = run('guard', { base: read(casePath(46, 'base')), head: read(casePath(46, 'head')) }, {}, { approvals }, loadSchemas());
  const guarded = await call('cupel_guard', { baseInput: casePath(46, 'base'), headInput: casePath(46, 'head'), approvals });
  assert.deepEqual(guarded.json, expectedGuard.report);
  assert.equal(guarded.result.isError, false);
});

test('report and label page units without truncating nested fields', async () => {
  for (const [name, number] of [['cupel_report', 18], ['cupel_label', 18]]) {
    const full = run(name.slice(6), { input: read(casePath(number, 'input')) }, {}, {}, loadSchemas()).report;
    const { json } = await call(name, { input: casePath(number, 'input'), page: 2, pageSize: 2 });
    assert.deepEqual(json, { suite: full.suite, units: full.units.slice(2, 4), groups: full.groups, page: 2, pages: 2 });
  }
});

test('JSON-RPC errors, invalid inputs and stdout framing', async () => {
  assert.equal((await send('missing')).error.code, -32601);
  assert.equal((await send('tools/call', { name: 'missing' })).error.code, -32602);
  assert.equal((await send('tools/call', { name: 'cupel_report', arguments: null })).error.code, -32602);
  assert.equal((await send('tools/call', { name: 'cupel_report', arguments: { pageSize: 201 } })).error.code, -32602);
  assert.equal((await send('initialize', { protocolVersion: 42 })).error.code, -32602);
  assert.equal((await raw('{bad json')).error.code, -32700);
  const invalid = await call('cupel_report', { input: `${CASES}missing-input.json` });
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.json.exit, 2);
  const mismatch = await call('cupel_guard', { baseInput: casePath(48, 'base'), headInput: casePath(48, 'head') });
  assert.equal(mismatch.result.isError, true);
  assert.deepEqual(mismatch.json, run('guard', { base: read(casePath(48, 'base')), head: read(casePath(48, 'head')) }, {}, {}, loadSchemas()).report);
  assert.deepEqual((await send('ping')).result, {});
});

test('collection reports a missing mutator instead of using reduced evidence', () => {
  for (const name of ['cupel_report', 'cupel_review']) {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } };
    const result = spawnSync(process.execPath, [BIN, 'mcp', '--root', ROOT], {
      cwd: tmpdir(), input: `${JSON.stringify(message)}\n`, encoding: 'utf8', timeout: 5000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CUPEL_TEST_COLLECTOR: fileURLToPath(new URL('fixtures/stub-collector.mjs', import.meta.url)),
        CUPEL_TEST_MUTATOR: `${ROOT}missing-mutator.mjs`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /mutation not available/);
    assert.equal(JSON.parse(response.result.content[1].text).exit, 3);
  }
});
