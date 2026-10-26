import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBenchmark } from './report.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerArgs } from './docker.mjs';
import { sourceFile, testFile } from './git.mjs';

const repo = { name: 'sample', dir: '/tmp/sample', language: 'TypeScript', runner: 'vitest', image: 'node:22-bookworm', notes: 'unit only' };
const candidate = { repo: 'org/sample', sizeKB: 2048, agentShare: 0.5, commitsSampled: 200 };

test('rendering fake measurements shows metrics, replay losses and caveats', () => {
  const markdown = renderBenchmark([repo], [candidate], { sample: {
    baseline: { status: 'ok', medianMs: 1000, runs: [{ counts: { passed: 10, failed: 0, skipped: 1 } }] },
    report: { status: 'ok', collectionMs: 1200, wallMs: 3000, overheadRatio: 1.2, peakKb: 2048,
      suite: { coverage: { pct: 80 }, criticalCoverage: { pct: 90 }, criticalMutation: { score: 60, detected: 6, undetected: 4 }, advice: { rewrite: 1 } },
      topSurvivors: [{ source: 'src/x.ts', line: 3, operator: 'negate' }], rewritePins: [{ file: 'tests/x.ts', brittle: ['source-text'] }],
      groups: [{ file: 'tests/x.ts', units: ['a', 'b'] }], noUniqueEvidenceCount: 1, noUniqueEvidence: ['u1'] },
    'guard-replay': { status: 'ok', outcomes: [{ commit: 'a'.repeat(40), pass: false, checks: [{ id: 'critical-mutation', pass: false, lostLines: {}, criticalMutantsLost: ['m1'] }], removed: [] }] },
    'plan-replay': { status: 'ok', outcomes: [{ commit: 'b'.repeat(40), selectedShare: 0.5, expectedMs: 20, fullMs: 40, touched: [{ id: 'u', bucket: 'affected' }] }] },
  } });
  assert.match(markdown, /critical mutation score 60\.00%/);
  assert.match(markdown, /Recorded top surviving mutants \(total statuses unavailable\)/);
  assert.match(markdown, /FAIL \(critical-mutation\)/);
  assert.match(markdown, /50\.0% \| — \| 0\.02 s/);
  assert.match(markdown, /Method and limits/);
  assert.match(markdown, /No overhead ratio is claimed/);
});

test('unrun repositories stay visibly unrun', () => {
  const markdown = renderBenchmark([repo], [candidate], {});
  assert.match(markdown, /not run/);
  assert.match(markdown, /baseline: not run/);
});

test('environment failures are listed without changing a completed baseline to failed', () => {
  const markdown = renderBenchmark([repo], [candidate], { sample: {
    baseline: { status: 'ok', medianMs: 1000, runs: [{ counts: { passed: 9, failed: 1, skipped: 0 } }],
      failingTests: ['tests/webdav.py::test_connection'], flakyCheck: { repeatedFailures: ['tests/webdav.py::test_connection'] } },
  } });
  assert.match(markdown, /baseline: ok/);
  assert.match(markdown, /Environment failures:.*tests\/webdav\.py::test_connection.*repeated on check/);
});

test('separate failed all-stage invocation remains visible after later stage success', () => {
  const markdown = renderBenchmark([repo], [candidate], { sample: {
    report: { status: 'ok', suite: { advice: { rewrite: 0 } } },
    all: { status: 'failed', reason: 'collector did not report tests' },
  } });
  assert.match(markdown, /- report: ok/);
  assert.match(markdown, /- all: failed — collector did not report tests/);
});

test('Docker command only mounts candidate, read-only Cupel and cache', () => {
  const args = dockerArgs(repo, 'none', 'npm test');
  const mounts = args.flatMap((arg, i) => args[i - 1] === '-v' ? [arg] : []);
  assert.equal(mounts.length, 3);
  assert.ok(mounts.some((m) => m.endsWith(':/cupel:ro')));
  assert.ok(args.includes('none'));
  assert.throws(() => dockerArgs(repo, 'host', 'npm test'));
});

test('commit classifiers exclude test and configuration changes from source replay', () => {
  assert.equal(testFile('src/__tests__/engine.test.ts'), true);
  assert.equal(testFile('pkg/github/server_test.go'), true);
  assert.equal(sourceFile('src/engine.ts'), true);
  assert.equal(sourceFile('crates/text/src/lib.rs'), true);
  assert.equal(sourceFile('src/__tests__/engine.test.ts'), false);
  assert.equal(sourceFile('vitest.config.ts'), false);
});

test('report uses saved mutation evidence and never reads retained candidate inputs', () => {
  mkdirSync('.scratch', { recursive: true });
  const dir = mkdtempSync('.scratch/bench-report-');
  try {
    mkdirSync(join(dir, '.cupel'));
    const statuses = ['killed', 'timeout', 'survived', 'survived', 'no-coverage', 'error'];
    writeFileSync(join(dir, '.cupel/input.json'), JSON.stringify({ mutation: { mutants: statuses.map((status, index) =>
      ({ status, source: 'src/a.ts', line: index + 1, operator: 'op' })) } }));
    const base = { report: { status: 'ok', suite: { criticalMutation: { score: 50 }, advice: { rewrite: 0 } } } };
    const markdown = renderBenchmark([{ ...repo, dir }], [candidate], { sample: base });
    assert.match(markdown, /50\.00% \| — \| — \| — \| — \| —/);
    assert.doesNotMatch(markdown, /src\/a\.ts/);
    base.report.mutationEvidence = { counts: { killed: 1, timeout: 1, survived: 2, 'no-coverage': 1, error: 1 },
      survivors: [{ source: 'src/b.ts', line: 7, operator: 'op' }] };
    const saved = renderBenchmark([{ ...repo, dir }], [candidate], { sample: base });
    assert.match(saved, /50\.00% \| 1 \| 1 \| 2 \| 1 \| 1/);
    assert.match(saved, /src\/b\.ts \| 7 \| op/);
    assert.doesNotMatch(saved, /src\/a\.ts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
