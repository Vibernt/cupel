// Audit (SPEC 11b, U1-U7): one read-only report across six questions about a
// suite, as a signal for people and coding agents. Pure: no I/O, no clock.
// It never advises removing a test (D5): overlap and look-alikes are evidence.

import { cmp, sortedUnique } from './order.mjs';
import { diff, format, intersect, mapIntersect, mapSize, size, union } from './lines.mjs';
import { coverageRatio } from './rational.mjs';
import { shapeSimilarity } from './advice.mjs';
import { lineJaccard } from './model.mjs';
import { ratioAtLeast } from './rational.mjs';

export const AUDIT_NOTICE = 'A signal, not a verdict: no test is ever advised for removal. '
  + 'Overlap and look-alikes are evidence for a person or agent to read; any change to tests must pass guard. '
  + 'Coverage and caught faults show what ran and what was noticed, never whether an expectation is right.';

const PIN_KINDS = new Set(['source-text', 'css-class', 'doc-wording', 'file-snapshot']);
const lineOf = (own, source, line) => (own.get(source) ?? []).some(([a, b]) => line >= a && line <= b);
const ext = (file) => (/\.(\w+)$/.exec(file)?.[1] ?? '').toLowerCase();
const FORMS = { rs: 'table-of-cases', py: 'parametrize', js: 'each', mjs: 'each', cjs: 'each', ts: 'each', mts: 'each', cts: 'each', tsx: 'each', jsx: 'each', go: 'table-of-cases', rb: 'table-of-cases' };
const formOf = (file) => FORMS[ext(file)] ?? 'table-of-cases';
const runnerOf = (u) => sortedUnique(u.rowTests.map((t) => t.runner ?? '')).join(',');

/** U2: possibly wrong tests. */
function wrong(model) {
  const out = [];
  for (const u of model.units) {
    const reasons = [];
    if (u.status === 'failed') reasons.push('fails');
    if (u.status === 'skipped') reasons.push('skipped');
    const statuses = u.rowTests.flatMap((t) => t.runStatuses ?? []);
    if (statuses.includes('passed') && statuses.includes('failed')) reasons.push('flaky');
    for (const f of u.findings) {
      if (PIN_KINDS.has(f.kind) && f.deliberate !== true) reasons.push(`pinned:${f.kind}`);
      if (f.kind === 'no-assertion' || f.kind === 'tautology') reasons.push(f.kind);
    }
    if (reasons.length) out.push({ unit: u.id, file: u.file, reasons: sortedUnique(reasons) });
  }
  return out;
}

/** U3: tests that catch no fault, or only by a crash in the code; code that runs with faults unnoticed. */
function falseTests(model) {
  if (!model.mutation) return { measured: false, units: [], unchecked: [], timeoutOnly: [] };
  const live = model.mutants.filter((m) => m.status !== 'error');
  const units = [];
  for (const u of model.units) {
    if (u.status !== 'passed' || model.fileLevel || !u.targeted) continue;
    const covered = live.filter((m) => lineOf(u.own, m.source, m.line));
    if (!covered.length) continue;
    const caught = live.filter((m) => m.detected && m.killerUnits.has(u.id));
    const kinds = caught.map((m) => {
      const rows = u.rows.filter((r) => m.killKinds?.[r]);
      if (!rows.length) return null;
      return rows.some((r) => m.killKinds[r] === 'assertion') ? 'assertion' : 'panic';
    });
    const entry = { unit: u.id, file: u.file, coveredMutants: covered.length, kills: caught.length,
      panicKills: kinds.filter((k) => k === 'panic').length };
    if (!caught.length) units.push({ ...entry, reason: 'catches-nothing' });
    else if (kinds.every((k) => k === 'panic')) units.push({ ...entry, reason: 'catches-only-by-panic' });
  }
  const bySource = new Map();
  for (const m of live.filter((x) => x.status === 'survived')) {
    if (!bySource.has(m.source)) bySource.set(m.source, []);
    bySource.get(m.source).push(m);
  }
  const unchecked = [...bySource].sort(([a], [b]) => cmp(a, b)).map(([source, ms]) => ({
    source,
    lines: format(ms.reduce((set, m) => union(set, [[m.line, m.line]]), [])),
    mutants: ms.sort((a, b) => cmp(a.id, b.id)).map((m) => ({ id: m.id, line: m.line, ...(m.description ? { description: m.description } : {}) })),
  }));
  const timeoutOnly = live.filter((m) => m.status === 'timeout').map((m) => m.id).sort(cmp);
  return { measured: true, units, unchecked, timeoutOnly };
}

/** U4: tests that protect the same thing: equal caught-fault sets (targeted units), or equal own lines. */
function overlap(model) {
  const passed = model.units.filter((u) => u.status === 'passed' && !model.fileLevel);
  const groups = new Map();
  for (const u of passed) {
    let key = null; let basis = null;
    // Only a targeted unit has a complete kill set: a mutant run stops once two test files (or
    // units) caught it, so other units' kill sets can be partial. Those group by own lines.
    if (model.mutation && u.targeted) {
      const kills = model.mutants.filter((m) => m.detected && m.killerUnits.has(u.id)).map((m) => m.id).sort(cmp);
      if (kills.length) { key = `k${JSON.stringify(kills)}`; basis = 'kills'; }
    }
    if (!key && mapSize(u.own) > 0) {
      key = `l${JSON.stringify([...u.own].sort(([a], [b]) => cmp(a, b)).map(([s, r]) => [s, format(r)]))}`; basis = 'lines';
    }
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { basis, units: [] });
    groups.get(key).units.push(u);
  }
  return [...groups.values()].filter((g) => g.units.length > 1).map((g) => ({
    basis: g.basis,
    units: g.units.map((u) => u.id).sort(cmp),
    crossRunner: new Set(g.units.map(runnerOf)).size > 1,
  })).sort((a, b) => cmp(a.units[0], b.units[0]));
}

/** U5: tests to combine: same-file groups (A9), and same-language look-alikes across files. */
function combine(model, cfg) {
  const groups = (model.groups ?? []).map((g) => ({ group: g.id, file: g.file, units: g.units, form: formOf(g.file) }));
  const eligible = model.fileLevel ? [] : model.units.filter((u) => u.status === 'passed' && u.findings.length === 0 && u.shape);
  const parent = new Map(eligible.map((u) => [u.id, u.id]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const u = eligible[i]; const v = eligible[j];
    if (u.file === v.file || ext(u.file) !== ext(v.file) || u.critical !== v.critical) continue;
    const s = shapeSimilarity(u, v); const l = lineJaccard(u.own, v.own);
    if (!ratioAtLeast(s.num, s.den, cfg.advice.shapeSimilarity) || !ratioAtLeast(l.num, l.den, cfg.advice.lineJaccard)) continue;
    const a = find(u.id); const b = find(v.id);
    if (a !== b) parent.set(cmp(a, b) < 0 ? b : a, cmp(a, b) < 0 ? a : b);
  }
  const comps = new Map();
  for (const u of eligible) { const r = find(u.id); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(u); }
  const acrossFiles = [...comps.values()].filter((c) => c.length > 1)
    .map((c) => ({ units: c.map((u) => u.id).sort(cmp), files: sortedUnique(c.map((u) => u.file)), form: 'shared-helper' }))
    .sort((a, b) => cmp(a.units[0], b.units[0]));
  return { groups, acrossFiles };
}

/** U6: coverage per source; sources that could not be measured are listed apart. */
function coverage(model) {
  const files = [];
  const unmeasured = [];
  for (const [source, s] of [...model.sources].sort(([a], [b]) => cmp(a, b))) {
    const reason = model.input.sources[source]?.unmeasured;
    if (reason !== undefined) { unmeasured.push({ source, reason }); continue; }
    if (!size(s.coverable)) continue;
    const covered = intersect(model.covered.get(source) ?? [], s.coverable);
    files.push({ source, critical: s.critical === true, ...coverageRatio(size(covered), size(s.coverable)), uncovered: format(diff(s.coverable, covered)) });
  }
  return { files, unmeasured };
}

/** U7: where test time goes. */
function speed(model, limit) {
  const slowest = [...model.units].filter((u) => u.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs || cmp(a.id, b.id)).slice(0, limit)
    .map((u) => ({ unit: u.id, durationMs: u.durationMs }));
  const slowLowValue = model.units.filter((u) => (u.reasons ?? []).includes('slow-low-value')).map((u) => u.id).sort(cmp);
  let mutationCostMs = null;
  if (model.mutation) {
    mutationCostMs = 0;
    for (const m of model.mutants) if (m.status !== 'error') {
      for (const u of model.units) if (lineOf(u.own, m.source, m.line)) mutationCostMs += u.durationMs;
    }
  }
  return { slowest, slowLowValue, mutationCostMs };
}

/** The audit section (SPEC 11b). `args.limit` bounds `speed.slowest` (default 10). */
export function auditSection(model, cfg, args = {}) {
  const limit = args.limit ?? 10;
  const w = wrong(model);
  return {
    notice: AUDIT_NOTICE,
    wrong: w,
    falseTests: falseTests(model),
    overlap: overlap(model),
    combine: combine(model, cfg),
    coverage: coverage(model),
    speed: { ...speed(model, limit), flaky: w.filter((x) => x.reasons.includes('flaky')).map((x) => x.unit) },
  };
}
