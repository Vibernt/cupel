import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
function checked(script, args = []) {
  const child = spawnSync(process.execPath, [join(repo, 'plans/spikes/s19', script), ...args],
    { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('real Session.select replay keeps IDs, file order and counters exact', () => {
  const manifest = checked('build.mjs');
  const result = JSON.parse(readFileSync(checked('replay.mjs', [manifest]), 'utf8'));
  assert.equal(result.sampledQueries, 200);
  assert.ok(result.totalAvailableUnique >= result.coveredAvailableUnique);
  assert.ok(result.coveredAvailableUnique > result.sampledQueries);
  assert.equal(result.profile.calls, result.sampledQueries);
  assert.equal(result.profile.firstParseCalls + result.profile.repeatedParseCalls,
    result.profile.parseCalls);
  assert.ok(result.profile.targetedFull > 0);
  assert.ok(result.selectedRows.some(row => row.selectedIds.length));
  assert.ok(result.selectedRows.some(row => row.fileOrder.length));
  assert.equal(new Set(result.selectedRows.map(row => `${row.source}\0${row.line}`)).size,
    result.sampledQueries);
});
