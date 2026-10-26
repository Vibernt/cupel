import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/engine/index.mjs';
import { loadSchemas } from '../src/cli/context.mjs';
import { ReportSnapshots } from '../src/mcp/report-snapshots.mjs';
import { callTool, validateCall } from '../src/mcp/tools.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const INPUT = join(ROOT, 'spec/conformance/cases/018-consolidate-same-shape/input.json');
const source = JSON.parse(readFileSync(INPUT, 'utf8'));
const full = run('report', { input: source }, {}, {}, loadSchemas());
const json = result => JSON.parse(result.content[1].text);
const withoutMetadata = page => {
  const { snapshotId, snapshot, ...legacy } = page;
  return legacy;
};

function harness(cache = new ReportSnapshots(ROOT), exit = 0) {
  let calls = 0;
  const reportSource = structuredClone(full.report);
  const executeMain = async (_argv, io) => {
    calls++;
    if (exit < 2) io.result({ report: reportSource, exit });
    else io.err(`fixture failure ${exit}\n`);
    return exit;
  };
  const context = { root: ROOT, env: {}, reportSnapshots: cache, executeMain };
  return { context, calls: () => calls, reportSource };
}

test('retention captures all units before paging; replay is historical and invokes no CLI', async () => {
  const h = harness();
  const ordinary = await callTool('cupel_report', { input: INPUT, pageSize: 2 }, h.context);
  assert.equal(h.calls(), 1);
  const retained = await callTool('cupel_report', { input: INPUT, pageSize: 2, retain: true }, h.context);
  assert.equal(h.calls(), 2);
  const first = json(retained);
  assert.equal(first.units.length, 2);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.snapshot, { kind: 'report', replay: false, historical: true });
  assert.match(retained.content[0].text, /saved historical report/);
  assert.equal(JSON.stringify(withoutMetadata(first)), JSON.stringify(json(ordinary)));

  const second = await callTool('cupel_report', { snapshotId: first.snapshotId, page: 2, pageSize: 2 }, h.context);
  assert.equal(h.calls(), 2, 'replay did not invoke the CLI, collector or mutator');
  assert.deepEqual(json(second).units, full.report.units.slice(2));
  assert.deepEqual(json(second).snapshot, { kind: 'report', replay: true, historical: true });
  assert.match(second.content[0].text, /historical report/);
  const differentlyPaged = await callTool('cupel_report', { snapshotId: first.snapshotId, pageSize: 3 }, h.context);
  assert.equal(h.calls(), 2);
  assert.deepEqual(json(differentlyPaged).units, full.report.units.slice(0, 3));

  const freshAgain = await callTool('cupel_report', { input: INPUT, pageSize: 2 }, h.context);
  assert.equal(h.calls(), 3, 'a second ordinary call is fresh');
  assert.equal(JSON.stringify(json(freshAgain)), JSON.stringify(json(ordinary)));
  first.units[0].advice = 'mutated by caller';
  h.reportSource.units[2].advice = 'mutated source';
  const replayAfterMutation = await callTool('cupel_report', { snapshotId: first.snapshotId, page: 2, pageSize: 2 }, h.context);
  assert.notEqual(json(replayAfterMutation).units[0].advice, 'mutated source');
});

test('snapshot arguments are report-only; replay rejects every execution argument', () => {
  assert.equal(validateCall('cupel_report', { retain: true, input: INPUT }), null);
  assert.equal(validateCall('cupel_report', { retain: false }), null);
  assert.equal(validateCall('cupel_report', { snapshotId: 'r1.a.b', page: 2 }), null);
  for (const args of [
    { snapshotId: 'x', retain: false }, { snapshotId: 'x', input: INPUT },
    { snapshotId: 'x', config: 'cupel.json' }, { snapshotId: 'x', unknown: 'x' },
  ]) assert.match(validateCall('cupel_report', args), /snapshotId|unknown argument/);
  assert.match(validateCall('cupel_report', { retain: 'true' }), /retain/);
  assert.match(validateCall('cupel_report', { snapshotId: '' }), /snapshotId/);
  assert.match(validateCall('cupel_report', { page: 0 }), /page/);
  assert.match(validateCall('cupel_report', { pageSize: 201 }), /pageSize/);
  for (const name of ['cupel_check', 'cupel_review', 'cupel_guard', 'cupel_plan', 'cupel_label']) {
    assert.match(validateCall(name, { retain: true }), /unknown argument/);
    assert.match(validateCall(name, { snapshotId: 'x' }), /unknown argument/);
  }
});

test('completed exit 1 reports may be retained and replayed as normal tool results', async () => {
  const h = harness(new ReportSnapshots(ROOT), 1);
  const first = await callTool('cupel_report', { retain: true, pageSize: 2 }, h.context);
  assert.equal(first.isError, false);
  const handle = json(first).snapshotId;
  const replay = await callTool('cupel_report', { snapshotId: handle, page: 2, pageSize: 2 }, h.context);
  assert.equal(replay.isError, false);
  assert.equal(h.calls(), 1);
  assert.deepEqual(json(replay).units, full.report.units.slice(2));
});

test('cache has deterministic identity, deep copies, root binding and integrity checks', () => {
  const cache = new ReportSnapshots(ROOT);
  const report = { units: [{ id: 'u', value: 1 }] };
  const id = cache.put(report, 0);
  report.units[0].value = 9;
  assert.equal(cache.get(id, ROOT).report.units[0].value, 1);
  cache.get(id, ROOT).report.units[0].value = 7;
  assert.equal(cache.get(id, ROOT).report.units[0].value, 1);
  assert.equal(cache.put({ units: [{ id: 'u', value: 1 }] }, 0), id);
  assert.equal(cache.entries.size, 1);
  assert.throws(() => cache.put(null, 0), /completed report/);
  assert.throws(() => cache.get(id, '/another/repo'), /root/);
  assert.throws(() => new ReportSnapshots('/another/repo').get(id, '/another/repo'), /root/);
  assert.throws(() => cache.get('bad-id', ROOT), /invalid/);
  cache.entries.get(id).serialized = '{}';
  assert.throws(() => cache.get(id, ROOT), /integrity/);
  assert.equal(cache.totalBytes, 0);
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.get(cache.put({ units: [{ id: 'safe' }] }, 0), ROOT).report.units[0].id, 'safe');
});

test('corrupt byte counts and entry shapes poison accounting instead of disabling bounds', () => {
  for (const damage of [
    entry => { entry.bytes = 'bad'; },
    entry => { entry.bytes = Number.NaN; },
    entry => { entry.lastUse = null; },
    (_entry, cache, id) => { cache.entries.set(id, null); },
  ]) {
    const cache = new ReportSnapshots(ROOT, { maxEntries: 2, maxBytes: 1024 });
    const report = { units: [{ id: 'a' }] };
    const id = cache.put(report, 0);
    damage(cache.entries.get(id), cache, id);
    assert.throws(() => cache.get(id, ROOT), /accounting integrity/);
    assert.throws(() => cache.put(report, 0), /accounting integrity/, 'duplicate insert must detect corruption');
    assert.throws(() => cache.put({ units: [{ id: 'b' }] }, 0), /accounting integrity/, 'new insert must not bypass byte bound');
    assert.ok(Number.isSafeInteger(cache.totalBytes), 'totalBytes never becomes NaN');
    assert.ok(cache.totalBytes <= cache.maxBytes);
  }
});

test('both LRU bounds evict deterministically; oversized and unsuccessful reports are not cached', async () => {
  const count = new ReportSnapshots(ROOT, { maxEntries: 8, maxBytes: 1024 * 1024 });
  const ids = Array.from({ length: 8 }, (_, i) => count.put({ units: [{ id: `u${i}` }] }, 0));
  count.get(ids[0], ROOT);
  const ninth = count.put({ units: [{ id: 'u8' }] }, 0);
  assert.equal(count.entries.size, 8);
  assert.throws(() => count.get(ids[1], ROOT), /missing or evicted/);
  assert.equal(count.get(ids[0], ROOT).report.units[0].id, 'u0');
  assert.equal(count.get(ninth, ROOT).report.units[0].id, 'u8');

  const probe = new ReportSnapshots(ROOT);
  const report = { units: [{ id: 'a', payload: 'x'.repeat(100) }] };
  const bytes = probe.entries.get(probe.put(report, 0)).bytes;
  const bounded = new ReportSnapshots(ROOT, { maxEntries: 8, maxBytes: bytes * 2 + 10 });
  const one = bounded.put(report, 0);
  bounded.put({ units: [{ id: 'b', payload: 'x'.repeat(100) }] }, 0);
  bounded.put({ units: [{ id: 'c', payload: 'x'.repeat(100) }] }, 0);
  assert.throws(() => bounded.get(one, ROOT), /missing or evicted/);
  assert.ok(bounded.totalBytes <= bytes * 2 + 10);

  const tooSmall = new ReportSnapshots(ROOT, { maxEntries: 8, maxBytes: 64 });
  const h = harness(tooSmall);
  const oversized = await callTool('cupel_report', { retain: true }, h.context);
  assert.equal(h.calls(), 1);
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /too large/);
  assert.equal(tooSmall.entries.size, 0);
  for (const exit of [2, 3]) {
    const failedCache = new ReportSnapshots(ROOT);
    const failed = await callTool('cupel_report', { retain: true }, harness(failedCache, exit).context);
    assert.equal(failed.isError, true);
    assert.equal(failedCache.entries.size, 0);
  }
});

test('an MCP process replays its own handle; another process reports an explicit error', () => {
  const id = new ReportSnapshots(ROOT).put(full.report, full.exit);
  const request = (n, args) => JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call',
    params: { name: 'cupel_report', arguments: args } });
  const same = spawnSync(process.execPath, [BIN, 'mcp', '--root', ROOT], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
    input: `${request(1, { input: INPUT, retain: true, pageSize: 2 })}\n${request(2, { snapshotId: id, page: 2, pageSize: 2 })}\n`,
  });
  assert.equal(same.status, 0, same.stderr);
  const replies = same.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 2);
  assert.equal(json(replies[0].result).snapshotId, id);
  assert.equal(json(replies[1].result).snapshot.replay, true);
  const other = spawnSync(process.execPath, [BIN, 'mcp', '--root', ROOT], {
    cwd: ROOT, encoding: 'utf8', timeout: 5000,
    input: `${request(3, { snapshotId: id })}\n`,
  });
  assert.equal(other.status, 0, other.stderr);
  const absent = JSON.parse(other.stdout.trim()).result;
  assert.equal(absent.isError, true);
  assert.match(absent.content[0].text, /missing or evicted/);
});
