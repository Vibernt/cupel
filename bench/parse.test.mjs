import test from 'node:test';
import assert from 'node:assert/strict';
import { median, testCounts, peakKb, reportMetrics, guardMetrics, planMetrics } from './parse.mjs';

 test('median and runner summaries preserve missing counts', () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.equal(median([]), null);
  assert.deepEqual(testCounts('pytest', '=== 12 passed, 2 skipped in 1.23s ==='), { passed: 12, failed: 0, skipped: 2 });
  assert.deepEqual(testCounts('go', 'ok github.com/x/pkg 0.1s'), { passed: null, failed: null, skipped: null });
  assert.deepEqual(testCounts('dotnet', 'runner output without totals'), { passed: null, failed: null, skipped: null });
  assert.deepEqual(testCounts('vitest', 'Tests  2 failed | 4 passed (6)'), { passed: 4, failed: 2, skipped: 0 });
  assert.deepEqual(testCounts('minitest', '10 runs, 40 assertions, 1 failures, 2 errors, 3 skips'), { passed: 4, failed: 3, skipped: 3 });
  assert.equal(peakKb('Maximum resident set size (kbytes): 12345'), 12345);
});

test('Go JSON counts top-level tests, ignores subtests, and counts build failures', () => {
  const output = [
    '{"Action":"run","Package":"example/a","Test":"TestPass"}',
    '{"Action":"pass","Package":"example/a","Test":"TestPass"}',
    '{"Action":"run","Package":"example/a","Test":"TestNested"}',
    '{"Action":"run","Package":"example/a","Test":"TestNested/case"}',
    '{"Action":"skip","Package":"example/a","Test":"TestNested/case"}',
    '{"Action":"pass","Package":"example/a","Test":"TestNested"}',
    '{"Action":"fail","Package":"example/b","Output":"# example/b"}',
    '{"Action":"fail","Package":"example/b","Elapsed":0}',
  ].join('\n');
  assert.deepEqual(testCounts('go', output), { passed: 2, failed: 1, skipped: 0 });
});

test('report metrics extract critical survivors, advice and missing evidence', () => {
  const report = { kind: 'report', command: 'report', suite: { criticalMutation: { score: 50 } }, units: [
    { id: 'a', file: 'x.test.ts', advice: 'rewrite', signals: { brittle: ['source-text'] }, hints: ['no-unique-coverage-unverified'] },
  ], groups: [{ id: 'g1', file: 'x.test.ts', units: ['a', 'b'] }] };
  const input = { mutation: { mutants: [{ source: 'src/x.ts', line: 8, operator: 'boolean', status: 'survived' }] } };
  const metrics = reportMetrics(report, input);
  assert.deepEqual(metrics.topSurvivors, [{ source: 'src/x.ts', line: 8, operator: 'boolean' }]);
  assert.equal(metrics.rewritePins.length, 1);
  assert.equal(metrics.noUniqueEvidenceCount, 1);
  assert.equal(metrics.groups.length, 1);
  assert.equal(metrics.groupCount, 1);
});

test('guard metrics preserve failed checks and losses', () => {
  const value = guardMetrics({ kind: 'report', command: 'guard', guard: { pass: false, checks: [
    { id: 'critical-mutation', pass: false, lost: { lines: { 'src/x.ts': '2-3' }, mutants: ['m1'] } },
  ], removed: [{ id: 'u', tier: 'critical', uniqueLines: 2, uniqueKills: 1 }] } });
  assert.equal(value.pass, false);
  assert.deepEqual(value.checks[0].criticalMutantsLost, ['m1']);
  assert.deepEqual(value.checks[0].lostLines, { 'src/x.ts': '2-3' });
});

test('plan metrics use unit buckets and include touched tests', () => {
  const input = { tests: [
    { id: 't1', unit: 'u1', file: 'tests/x.test.ts', durationsMs: [10, 20] },
    { id: 't2', unit: 'u2', file: 'tests/y.test.ts', durationsMs: [30, 40] },
  ] };
  const report = { kind: 'report', command: 'plan', plan: { expectedMs: 35, order: [{ id: 'u1', bucket: 'affected', durationMs: 15 }], skipped: ['u2'] } };
  const value = planMetrics(report, input, ['tests/x.test.ts']);
  assert.equal(value.selectedShare, 0.5);
  assert.equal(value.fullMs, 50);
  assert.deepEqual(value.touched, [{ id: 't1', bucket: 'affected' }]);
});
