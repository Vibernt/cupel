import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCall, callTool } from '../src/mcp/tools.mjs';

const params = { profile: 'node-readonly-files-v2', base: 'a'.repeat(40),
  producerSha256: `sha256:${'1'.repeat(64)}`, workDir: '/private/work', out: '/private/result',
  baseline: '/private/base', baselineSha256: `sha256:${'2'.repeat(64)}` };

test('MCP selective contract requires explicit profile and every trust pin', () => {
  assert.equal(validateCall('cupel_pr', params), null);
  for (const key of Object.keys(params)) {
    const omitted = { ...params }; delete omitted[key];
    assert.match(validateCall('cupel_pr', omitted), /is required/);
  }
  assert.match(validateCall('cupel_pr', { ...params, profile: 'pytest' }), /profile must be/);
  assert.match(validateCall('cupel_pr', { ...params, retain: true }), /unknown argument/);
});

test('MCP maps PR options without paging or converting scoped data to full guard', async () => {
  let seen;
  const value = await callTool('cupel_pr', params, { root: '/subject', env: {},
    executeMain: async (argv, io) => {
      seen = argv;
      io.result({ exit: 1, report: { spec: 'cupel-pr-result/1', wholeGuardPass: false,
        exit: 1, route: 'selected', executedFiles: ['a'], unexecutedFiles: ['b'],
        costs: { requestMs: 100 } } });
      return 1;
    } });
  assert.equal(seen[0], 'pr');
  assert.ok(seen.includes('--baseline-sha256'));
  assert.ok(seen.includes('--producer-sha256'));
  assert.equal(value.isError, false);
  const data = JSON.parse(value.content[1].text);
  assert.equal(data.wholeGuardPass, false);
  assert.deepEqual(data.unexecutedFiles, ['b']);
  assert.match(value.content[0].text, /scoped PR failed/);
});
