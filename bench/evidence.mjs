import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));

export function reportInventory(input) {
  if (!Array.isArray(input.tests)) throw new Error('report input has no test inventory');
  const ids = input.tests.map((test) => test.id);
  if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('report input has an unnamed test');
  if (new Set(ids).size !== ids.length) throw new Error('report input has duplicate test IDs');
  const runners = {};
  for (const test of input.tests) {
    const runner = test.runner || 'unspecified';
    runners[runner] = (runners[runner] ?? 0) + 1;
  }
  const runnerIds = input.tests.map((test) => `${test.runner || 'unspecified'}\0${test.id}`);
  return { count: ids.length, idHash: hash(JSON.stringify(sorted(runnerIds))), idScheme: 'cupel-runner-file-name', runners,
    runnerSet: sorted(Object.keys(runners)) };
}

export function goBaselineInventory(output) {
  const ids = new Set();
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.Package && event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
      ids.add(`${event.Package}::${event.Test}`);
  }
  return ids.size ? { count: ids.size, idHash: hash(JSON.stringify(sorted(ids))),
    idScheme: 'go-package-test', runnerSet: ['go'] } : null;
}

const count = (run) => run?.counts?.passed == null || run?.counts?.failed == null || run?.counts?.skipped == null
  ? null : run.counts.passed + run.counts.failed + run.counts.skipped;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function auditComparison(baseline, report) {
  if (!baseline || !report) return { verdict: 'unavailable', reasons: ['baseline or report stage missing'] };
  if (baseline.status !== 'ok' || report.status !== 'ok')
    return { verdict: 'unavailable', reasons: ['baseline or report stage did not complete'] };
  const invalid = []; const unknown = [];
  const counts = (baseline.runs ?? []).map(count);
  const reported = report.collectionInventory?.count ?? report.collectedTests ?? report.suite?.tests;
  if (counts.some((n) => n == null) || reported == null) unknown.push('test counts unavailable');
  else if (counts.some((n) => n !== reported)) invalid.push(`baseline counts ${counts.join('/')} differ from collection ${reported}`);
  const b = baseline.identity; const r = report.identity;
  for (const key of ['candidateRevision', 'cupelRevision', 'configHash', 'image', 'imageId', 'runtime']) {
    if (b?.[key] == null || r?.[key] == null) unknown.push(`${key} provenance unavailable`);
    else if (!same(b[key], r[key])) invalid.push(`${key} differs`);
  }
  if (b?.candidateDirty !== false || b?.cupelDirty !== false || r?.candidateDirty !== false || r?.cupelDirty !== false)
    unknown.push('clean revision provenance unavailable');
  const baselineSet = baseline.runnerSet;
  const reportSet = report.collectionInventory?.runnerSet;
  if (!baselineSet || !reportSet || reportSet.includes('unspecified')) unknown.push('exact runner set unavailable');
  else if (!same(sorted(baselineSet), sorted(reportSet))) invalid.push(`runner sets differ: ${baselineSet.join(',')} versus ${reportSet.join(',')}`);
  const baselineIds = baseline.runs?.map((run) => run.inventory);
  if (!baselineIds?.length || baselineIds.some((value) => !value?.idHash)) unknown.push('baseline test-ID inventory unavailable');
  else if (baselineIds.some((value, index) => value.count !== counts[index])) invalid.push('baseline count summary differs from ID inventory');
  else if (baselineIds.some((value) => value.idHash !== baselineIds[0].idHash)) invalid.push('baseline test IDs differ between runs');
  else if (baselineIds[0].idScheme !== report.collectionInventory?.idScheme)
    unknown.push('baseline and collection test-ID schemes cannot be reconciled');
  else if (baselineIds[0].idHash !== report.collectionInventory.idHash) invalid.push('baseline and collection test IDs differ');
  if (!report.collectionInventory || !report.fullInventory) unknown.push('collection/full inventory provenance unavailable');
  else if (report.collectionInventory.idHash !== report.fullInventory.idHash || report.collectionInventory.count !== report.fullInventory.count)
    invalid.push('collection and full report test IDs differ');
  return { verdict: invalid.length ? 'invalid' : unknown.length ? 'unverified' : 'verified', reasons: [...invalid, ...unknown] };
}

export function mutationEvidence(input) {
  const mutants = input.mutation?.mutants;
  if (!Array.isArray(mutants)) return null;
  const counts = { killed: 0, timeout: 0, survived: 0, 'no-coverage': 0, error: 0 };
  for (const mutant of mutants) {
    if (!(mutant.status in counts)) throw new Error(`unknown mutation status ${mutant.status}`);
    counts[mutant.status]++;
  }
  return { counts, survivors: mutants.filter((m) => m.status === 'survived')
    .sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.operator.localeCompare(b.operator))
    .slice(0, 15).map(({ source, line, operator }) => ({ source, line, operator })) };
}
