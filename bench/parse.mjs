// Parsing of runner output and Cupel's public JSON results.
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function goJsonEvents(text) {
  return text.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === 'object' && event.Action && event.Package ? [event] : [];
    } catch {
      return [];
    }
  });
}

function goCounts(text) {
  const events = goJsonEvents(text);
  if (!events.length) return null;
  const tests = new Map();
  const packages = new Map();
  for (const event of events) {
    const packageState = packages.get(event.Package) ?? { failed: false, hasTestFailure: false };
    if (event.Action === 'fail' && !event.Test) packageState.failed = true;
    if (event.Action === 'fail' && event.Test && !event.Test.includes('/')) packageState.hasTestFailure = true;
    packages.set(event.Package, packageState);
    if (event.Test && !event.Test.includes('/') && ['pass', 'fail', 'skip'].includes(event.Action)) {
      tests.set(`${event.Package}\0${event.Test}`, event.Action);
    }
  }
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const action of tests.values()) counts[action === 'pass' ? 'passed' : action === 'fail' ? 'failed' : 'skipped']++;
  for (const packageState of packages.values()) if (packageState.failed && !packageState.hasTestFailure) counts.failed++;
  return counts;
}

export function goFailingNames(output) {
  const events = goJsonEvents(output);
  const names = events.filter((event) => event.Action === 'fail' && event.Test && !event.Test.includes('/'))
    .map((event) => event.Test);
  return [...new Set(names)].slice(0, 50);
}

export function testCounts(runner, output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const n = (pattern) => Number([...text.matchAll(pattern)].at(-1)?.[1] ?? 0);
  const unknown = { passed: null, failed: null, skipped: null };
  if (runner === 'pytest') return /\d+ (?:passed|failed|skipped)\b/.test(text) ? {
    passed: n(/(\d+) passed\b/g), failed: n(/(\d+) failed\b/g), skipped: n(/(\d+) skipped\b/g),
  } : unknown;
  if (runner === 'go') return goCounts(text) ?? unknown;
  if (runner === 'cargo') return /test result: (?:ok|FAILED)\./.test(text) ? {
    passed: [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)].reduce((a, m) => a + Number(m[1]), 0),
    failed: [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)].reduce((a, m) => a + Number(m[2]), 0),
    skipped: [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)].reduce((a, m) => a + Number(m[3]), 0),
  } : unknown;
  if (runner === 'dotnet') return /\b(?:Passed|Failed|Skipped):\s*\d+/i.test(text) ?
    { passed: n(/\bPassed:\s*(\d+)/gi), failed: n(/\bFailed:\s*(\d+)/gi), skipped: n(/\bSkipped:\s*(\d+)/gi) } : unknown;
  if (runner === 'minitest') {
    const match = [...text.matchAll(/(\d+) runs?,\s*\d+ assertions?,\s*(\d+) failures?,\s*(\d+) errors?,\s*(\d+) skips?/g)].at(-1);
    return match ? { passed: Number(match[1]) - Number(match[2]) - Number(match[3]) - Number(match[4]), failed: Number(match[2]) + Number(match[3]), skipped: Number(match[4]) } : unknown;
  }
  if (runner === 'vitest') return /^\s*Tests\s+.*\d+ (?:passed|failed|skipped)/m.test(text) ?
    { passed: n(/Tests\s+.*?(\d+) passed/g), failed: n(/Tests\s+.*?(\d+) failed/g), skipped: n(/Tests\s+.*?(\d+) skipped/g) } : unknown;
  return /^# (?:pass|fail|skipped) \d+/m.test(text) ?
    { passed: n(/^# pass (\d+)/gm), failed: n(/^# fail (\d+)/gm), skipped: n(/^# skipped (\d+)/gm) } : unknown;
}

export function peakKb(stderr) {
  const match = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

export function reportMetrics(report, input) {
  if (report.kind !== 'report' || report.command !== 'report' || !report.suite) throw new Error('Cupel did not return a report with suite metrics');
  // The ordinary report command only mutates critical code; no --evidence pass is requested here.
  const survivors = (input?.mutation?.mutants ?? []).filter((m) => m.status === 'survived')
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.operator.localeCompare(b.operator));
  return {
    suite: report.suite,
    topSurvivors: survivors.slice(0, 10).map(({ source, line, operator }) => ({ source, line, operator })),
    survivorScope: 'critical',
    rewritePins: (report.units ?? []).filter((u) => u.advice === 'rewrite').map((u) => ({ id: u.id, file: u.file, brittle: u.signals?.brittle ?? [] })).slice(0, 20),
    groupCount: (report.groups ?? []).length,
    groups: (report.groups ?? []).slice(0, 20),
    noUniqueEvidence: (report.units ?? []).filter((u) => u.hints?.some((h) => h.startsWith('no-unique'))).map((u) => u.id).slice(0, 20),
    noUniqueEvidenceCount: (report.units ?? []).filter((u) => u.hints?.some((h) => h.startsWith('no-unique'))).length,
  };
}

export function guardMetrics(report) {
  if (report.kind !== 'report' || report.command !== 'guard' || !report.guard) throw new Error('Cupel did not return guard JSON');
  const checks = report.guard.checks.map((c) => ({ id: c.id, pass: c.pass, missing: c.missing ?? false, lostLines: c.lost?.lines ?? {}, criticalMutantsLost: c.id === 'critical-mutation' ? (c.lost?.mutants ?? []) : [] }));
  return { pass: report.guard.pass, checks, removed: report.guard.removed };
}

export function planMetrics(report, input, touchedTests) {
  if (report.kind !== 'report' || report.command !== 'plan' || !report.plan) throw new Error('Cupel did not return plan JSON');
  const order = report.plan.order;
  const selected = order.filter((r) => ['critical', 'affected'].includes(r.bucket));
  const selectedDurationMs = selected.reduce((sum, entry) => sum + entry.durationMs, 0);
  const fullMs = (input.tests ?? []).reduce((n, t) => n + (median(t.durationsMs ?? []) ?? 0), 0);
  const buckets = new Map(order.map((r) => [r.id, r.bucket]));
  const touched = (input.tests ?? []).filter((t) => touchedTests.includes(t.file)).map((t) => ({ id: t.id, bucket: buckets.get(t.unit ?? t.id) ?? 'skipped' }));
  const total = order.length + report.plan.skipped.length;
  return { selected: selected.length, total, selectedShare: total ? selected.length / total : null,
    selectedDurationMs, expectedMs: report.plan.expectedMs, fullMs, touched };
}
