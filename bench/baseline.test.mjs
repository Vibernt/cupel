import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineRun, capturedError, reportCommandCompleted } from './baseline.mjs';

test('completed pytest with failed tests remains a valid baseline run', () => {
  const run = baselineRun('pytest', { stdout: 'FAILED tests/test_webdav.py::test_thing\n1 failed, 9 passed in 1s', stderr: '', exitCode: 1, wallMs: 1000, signal: null });
  assert.equal(run.complete, true);
  assert.deepEqual(run.counts, { passed: 9, failed: 1, skipped: 0 });
  assert.deepEqual(run.failingTests, ['tests/test_webdav.py::test_thing']);
});

test('crash without counts and timeout are incomplete', () => {
  assert.equal(baselineRun('pytest', { stdout: '', stderr: 'crashed', exitCode: 2, wallMs: 1 }).complete, false);
  assert.equal(baselineRun('pytest', { stdout: '1 passed', stderr: '', signal: 'SIGKILL', exitCode: 128, wallMs: 1 }).complete, false);
});

test('report accepts a completed command with failed tests and still rejects crashes', () => {
  assert.equal(reportCommandCompleted({ exitCode: 1, signal: null }), true);
  assert.equal(reportCommandCompleted({ exitCode: 2, signal: null }), false);
  assert.equal(reportCommandCompleted({ exitCode: 1, signal: 'SIGKILL' }), false);
});

test('capture preserves first and last forty stderr lines', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const value = capturedError({ stderr: lines.join('\n'), stdout: '' });
  assert.match(value, /^line 0\n/);
  assert.match(value, /line 39\n\.\.\. 20 lines omitted \.\.\.\nline 60/);
  assert.match(value, /line 99$/);
  assert.doesNotMatch(value, /line 50\n/);
});
