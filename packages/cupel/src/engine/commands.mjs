// Report sections: suite (R3), units, plan (P1-P3), check (C1-C4) and guard (G3-G9). Pure.

import { cmp, sortedUnique } from './order.mjs';
import { parse, mapDiff, mapIntersect, mapIsEmpty, mapSize, mapToObject, mapFilter } from './lines.mjs';
import { coverageCounts } from './model.mjs';
import { coverageRatio, mutationScore, fracAtLeast, decimal } from './rational.mjs';

const ADVICE = ['keep', 'consolidate', 'rewrite', 'move-to-check', 'none'];

function scoreOf(mutants) {
  let detected = 0;
  let undetected = 0;
  for (const m of mutants) {
    if (m.detected) detected++;
    else if (m.status === 'survived' || m.status === 'no-coverage') undetected++;
  }
  return mutationScore(detected, undetected);
}

/** R3. */
export function suiteSection(model) {
  const count = (s) => model.input.tests.filter((t) => t.status === s).length;
  const advice = Object.fromEntries(ADVICE.map((a) => [a, model.units.filter((u) => u.advice === a).length]));
  const all = coverageCounts(model);
  const crit = coverageCounts(model, model.critical);
  return {
    tests: model.input.tests.length,
    units: model.units.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    durationMs: model.units.reduce((n, u) => n + u.durationMs, 0),
    coverage: coverageRatio(all.covered, all.coverable),
    criticalCoverage: coverageRatio(crit.covered, crit.coverable),
    mutation: model.mutation ? scoreOf(model.mutants) : null,
    criticalMutation: model.mutation ? scoreOf(model.mutants.filter((m) => m.critical)) : null,
    advice,
  };
}

export function unitEntry(u) {
  const e = {
    id: u.id,
    file: u.file,
    rows: u.rows,
    tier: u.tier,
    tierReason: u.tierReason,
    protected: u.protected,
    status: u.status,
    signals: {
      ownLines: u.ownLines,
      uniqueLines: u.uniqueLines,
      kills: u.kills,
      uniqueKills: u.uniqueKills,
      durationMs: u.durationMs,
      runs: u.runs,
      brittle: u.brittle,
    },
    advice: u.advice,
    reasons: u.reasons,
    hints: u.hints,
  };
  if (u.group !== undefined) e.group = u.group;
  if (u.duplicateOf !== undefined) e.duplicateOf = u.duplicateOf;
  return e;
}

const byDurationThenId = (a, b) => a.durationMs - b.durationMs || cmp(a.id, b.id);

/** P1-P3. */
export function planSection(model, changed) {
  const order = [];
  const skipped = [];
  const push = (bucket, units) => {
    for (const u of [...units].sort(byDurationThenId)) order.push({ id: u.id, bucket, durationMs: u.durationMs });
  };
  if (changed === undefined) {
    for (const tier of ['critical', 'standard', 'minor']) push(tier, model.units.filter((u) => u.tier === tier));
    return { mode: 'full', order, skipped, expectedMs: order.reduce((n, e) => n + e.durationMs, 0) };
  }
  const changedPaths = Object.keys(changed);
  // A path with the empty line set counts as changed in full.
  const whole = new Set(changedPaths.filter((p) => changed[p] === ''));
  const changedLines = new Map(changedPaths.filter((p) => changed[p] !== '').map((p) => [p, parse(changed[p]).set]));
  const touches = (lineMap) => {
    for (const src of lineMap.keys()) if (whole.has(src)) return true;
    return !mapIsEmpty(mapIntersect(lineMap, changedLines));
  };
  const affected = (u) =>
    changedPaths.includes(u.file) || touches(u.own) || touches(model.setup.get(u.file) ?? new Map());
  const crit = [];
  const aff = [];
  const rest = [];
  for (const u of model.units) {
    if (u.critical) crit.push(u);
    else if (affected(u)) aff.push(u);
    else if (u.tier === 'standard') rest.push(u);
    else skipped.push(u.id);
  }
  push('critical', crit);
  push('affected', aff);
  push('rest', rest);
  return { mode: 'changed', order, skipped: skipped.sort(cmp), expectedMs: order.reduce((n, e) => n + e.durationMs, 0) };
}

/** The units named by argument `tests`: a unit id names itself, a test id names its unit. */
export function resolveUnits(model, names) {
  const ids = new Set();
  for (const name of names) {
    if (model.unitById.has(name)) ids.add(name);
    if (model.tests.has(name)) ids.add(model.rowUnit.get(name));
  }
  return [...ids].sort(cmp);
}

const detectedBy = (m, u) => m.detected && u.rows.some((r) => (m.killedBy ?? []).includes(r));

/** C1-C4. Returns { section, exit }. */
export function checkSection(head, base, names) {
  const verdicts = [];
  for (const id of resolveUnits(head, names)) {
    const u = head.unitById.get(id);
    const entry = { id, verdict: null };
    if (u.status === 'failed') entry.verdict = 'fails';
    else if (u.status === 'skipped') entry.verdict = 'not-run';
    else {
      const b = base?.unitById.get(id);
      const lost = b ? weakenedBy(u, b, head, base) : null;
      if (lost) {
        entry.verdict = 'weakens';
        entry.lost = lost;
      } else if (u.critical || u.uniqueLines >= 1 || u.uniqueKills >= 1) {
        entry.verdict = 'adds-value';
      } else {
        entry.verdict = 'no-unique-evidence';
        entry.extend = largestOverlap(u, head);
      }
    }
    entry.brittle = u.brittle;
    verdicts.push(entry);
  }
  return { section: { verdicts }, exit: verdicts.some((v) => ['weakens', 'fails', 'not-run'].includes(v.verdict)) ? 1 : 0 };
}

function weakenedBy(u, b, head, base) {
  const lines = mapDiff(b.own, u.own);
  const headMutants = new Map(head.mutants.map((m) => [m.id, m]));
  const mutants = [];
  for (const m of base.mutants) {
    if (!detectedBy(m, b)) continue;
    if (!head.mutation) mutants.push(m.id); // absent data is never "still detected"
    else if (headMutants.has(m.id) && !detectedBy(headMutants.get(m.id), u)) mutants.push(m.id);
  }
  if (mapIsEmpty(lines) && mutants.length === 0) return null;
  return { lines: mapToObject(lines), mutants: sortedUnique(mutants) };
}

function largestOverlap(u, model) {
  let best = null;
  let bestSize = 0;
  for (const v of model.units) {
    if (v === u) continue;
    const n = mapSize(mapIntersect(u.own, v.own));
    if (n > bestSize) {
      best = v.id;
      bestSize = n;
    }
  }
  return best; // units are in ascending id order, so ties keep the smallest id
}

/** covered/coverable at head is not lower than at base. A whole of 0 is handled conservatively. */
function notLower(base, head) {
  if (base.coverable === 0) return true;
  if (head.coverable === 0) return base.covered === 0;
  return fracAtLeast(head.covered, head.coverable, base.covered, base.coverable);
}

/** covered/coverable is at least N percent. With nothing coverable the bound holds vacuously. */
function atLeastPercent(r, n) {
  if (r.coverable === 0) return true;
  const [num, den] = decimal(n);
  return BigInt(r.covered) * 100n * den >= num * BigInt(r.coverable);
}

/** G3-G9. Returns { section, exit }. */
export function guardSection(base, head, cfg, approvals = []) {
  const approved = (action, id) => approvals.some((a) => a.action === action && a.id === id);
  const checks = [];

  // G3
  checks.push({ id: 'head-passes', pass: head.units.every((u) => u.status !== 'failed') });

  // G4
  const lost = new Map();
  for (const [src, s] of base.sources) {
    const h = head.sources.get(src);
    if (!h || s.hash === undefined || h.hash === undefined || s.hash !== h.hash) continue;
    const gone = mapDiff(mapFilter(base.covered, (p) => p === src), head.covered);
    for (const [p, set] of gone) lost.set(p, set);
  }
  checks.push({ id: 'coverage-lines', pass: lost.size === 0, lost: { lines: mapToObject(lost) } });
  const ratio = (m, keep) => {
    const c = coverageCounts(m, keep);
    return coverageRatio(c.covered, c.coverable);
  };
  const baseAll = ratio(base);
  const headAll = ratio(head);
  checks.push({ id: 'coverage-ratio', pass: notLower(baseAll, headAll), base: baseAll, head: headAll });

  // G5: every critical source present in both, one by one and together.
  const shared = [...base.sources.keys()].filter((p) => head.sources.has(p) && base.critical(p) && head.critical(p));
  const threshold = cfg.guard.criticalCoverage;
  const failing = [];
  for (const src of shared) {
    const b = ratio(base, (p) => p === src);
    const h = ratio(head, (p) => p === src);
    if (!notLower(b, h) || (threshold !== 'ratchet' && !atLeastPercent(h, threshold))) failing.push(src);
  }
  const inShared = (p) => shared.includes(p);
  const bc = ratio(base, inShared);
  const hc = ratio(head, inShared);
  const aggregateOk = notLower(bc, hc) && (threshold === 'ratchet' || atLeastPercent(hc, threshold));
  checks.push({ id: 'critical-coverage', pass: failing.length === 0 && aggregateOk, sources: failing.sort(cmp) });

  // G6
  const baseCritical = base.mutants.filter((m) => m.critical);
  if (baseCritical.length > 0 && !head.mutation) {
    // Absent data is never a pass; what was lost cannot be known, so only `missing` is reported.
    checks.push({ id: 'critical-mutation', pass: false, missing: true });
  } else {
    const headById = new Map(head.mutants.map((m) => [m.id, m]));
    const gone = baseCritical.filter((m) => m.detected && headById.has(m.id) && !headById.get(m.id).detected).map((m) => m.id);
    checks.push({ id: 'critical-mutation', pass: gone.length === 0, lost: { mutants: sortedUnique(gone) } });
  }

  // G7, G8
  const removedCritical = [];
  const downgraded = [];
  for (const u of base.units) {
    if (!u.critical) continue;
    const h = head.unitById.get(u.id);
    if (!h) {
      if (!approved('remove', u.id)) removedCritical.push(u.id);
    } else if (!h.critical && !approved('downgrade', u.id)) {
      downgraded.push(u.id);
    }
  }
  checks.push({ id: 'critical-removed', pass: removedCritical.length === 0, units: removedCritical.sort(cmp) });
  checks.push({ id: 'critical-downgraded', pass: downgraded.length === 0, units: downgraded.sort(cmp) });

  // G9
  const removed = base.units
    .filter((u) => !head.unitById.has(u.id))
    .map((u) => ({ id: u.id, tier: u.tier, uniqueLines: u.uniqueLines, uniqueKills: u.uniqueKills }));

  const pass = checks.every((c) => c.pass);
  return { section: { pass, checks, removed }, exit: pass ? 0 : 1 };
}

