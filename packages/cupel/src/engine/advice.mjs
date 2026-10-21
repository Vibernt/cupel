// Advice (SPEC section 7): A1-A12, consolidation groups (A9) and the retire pass (A10). Pure.

import { cmp, sortedUnique } from './order.mjs';
import { mapUnionAll, mapUnion, mapSubset, mapIsEmpty, exclusiveLines, mapDiff, mapSize } from './lines.mjs';
import { jaccard, lineJaccard } from './model.mjs';
import { ratioAtLeast } from './rational.mjs';

/** shape(u, v) as { num, den }: 0 when either shape is missing or both are empty (S6). */
export function shapeSimilarity(u, v) {
  if (!u.shape || !v.shape) return { num: 0, den: 0 };
  return jaccard(u.shape, v.shape);
}

const atLeast = (frac, threshold) => ratioAtLeast(frac.num, frac.den, threshold);

/** A9: consolidation groups, as [{ id, kind, file, units }]. */
export function consolidationGroups(model, cfg) {
  if (model.fileLevel || !cfg.advice.consolidate) return [];
  const eligible = model.units.filter((u) => u.status === 'passed' && u.findings.length === 0);
  const parent = new Map(eligible.map((u) => [u.id, u.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const u = eligible[i];
      const v = eligible[j];
      if (u.file !== v.file || u.critical !== v.critical) continue;
      if (!atLeast(shapeSimilarity(u, v), cfg.advice.shapeSimilarity)) continue;
      if (!atLeast(lineJaccard(u.own, v.own), cfg.advice.lineJaccard)) continue;
      const a = find(u.id);
      const b = find(v.id);
      if (a !== b) parent.set(cmp(a, b) < 0 ? b : a, cmp(a, b) < 0 ? a : b);
    }
  }
  const comps = new Map();
  for (const u of eligible) {
    const r = find(u.id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(u);
  }
  return [...comps.values()]
    .filter((c) => c.length >= 2)
    .map((c) => c.map((u) => u.id).sort(cmp))
    .sort((a, b) => cmp(a[0], b[0]))
    .map((ids, i) => ({ id: `g${i + 1}`, kind: 'same-shape', file: model.unitById.get(ids[0]).file, units: ids }));
}

/**
 * Assigns advice, reasons, hints, group and duplicateOf to every unit of the model.
 * Returns { groups }.
 */
export function advise(model, cfg) {
  const groups = consolidationGroups(model, cfg);
  const groupOf = new Map();
  for (const g of groups) for (const id of g.units) groupOf.set(id, g.id);

  const reachA10 = [];
  for (const u of model.units) {
    const hints = [];
    if (u.spawnsInterpreter) hints.push('spawns-interpreter');
    if (u.e2e) hints.push('low-evidence');
    u.hints = hints;
    u.reasons = [];
    const set = (advice, reasons = [], extraHints = []) => {
      u.advice = advice;
      u.reasons = reasons;
      u.hints.push(...extraHints);
    };
    if (u.status === 'failed') set('none', ['failed']); // A1
    else if (u.status === 'skipped') set('none', ['not-run']); // A2
    else if (u.pinned) set('rewrite', u.brittle.map((k) => `brittle:${k}`)); // A3
    else if (u.deliberatelyPinned) set('move-to-check', ['deliberate-pin']); // A4
    else if (model.fileLevel) {
      // A12: A5, A6 and A10 do not apply; units reaching A7 or later get keep.
      if (u.critical) set('keep', ['critical']);
      else set('keep', [], ['file-granularity']);
    } else if (groupOf.has(u.id)) {
      set('consolidate', ['same-shape']); // A5
      u.group = groupOf.get(u.id);
    } else if (
      !u.critical && u.runs >= cfg.advice.minRuns && u.durationMs >= cfg.advice.slowMs &&
      u.uniqueLines < cfg.advice.lowValueUniqueLines
    ) {
      set('rewrite', ['slow-low-value']); // A6
    } else if (u.critical || u.uniqueLines >= 1 || u.uniqueKills >= 1) {
      const r = [];
      if (u.critical) r.push('critical');
      if (u.uniqueLines >= 1) r.push('unique-lines');
      if (u.uniqueKills >= 1) r.push('unique-kills');
      set('keep', r); // A7
    } else if (mapIsEmpty(u.own)) {
      set('none', [], ['no-coverage-evidence']); // A8
    } else {
      reachA10.push(u);
    }
  }

  retirePass(model, cfg, reachA10);

  for (const u of reachA10) {
    if (u.advice === 'retire') continue;
    u.advice = 'keep'; // A11
    u.reasons = [];
    u.hints.push('no-unique-coverage-unverified');
  }
  for (const u of model.units) u.hints = sortedUnique(u.hints);
  return { groups };
}

/** Duplicate-path partners of u (A10): other passed units v with shape >= duplicateShape and own(v) ⊇ own(u). */
function duplicatesOf(u, model, cfg) {
  return model.units.filter(
    (v) => v !== u && v.status === 'passed' && atLeast(shapeSimilarity(u, v), cfg.advice.duplicateShape) && mapSubset(u.own, v.own),
  );
}

function retirePass(model, cfg, reached) {
  if (model.fileLevel) return;
  // Retire candidates, among the units that reach A10.
  const candidates = [];
  for (const u of reached) {
    if (u.protected || u.e2e || u.spawnsInterpreter) continue;
    if (u.status !== 'passed' || mapIsEmpty(u.own) || u.uniqueLines !== 0 || !u.rechecked) continue;
    const mutationPath = model.mutation !== null && u.targeted && u.uniqueKills === 0;
    const dups = duplicatesOf(u, model, cfg);
    const duplicatePath = dups.length > 0;
    if (!mutationPath && !duplicatePath) continue;
    candidates.push({ u, mutationPath, duplicatePath, dups });
  }
  candidates.sort((a, b) => b.u.durationMs - a.u.durationMs || cmp(a.u.id, b.u.id));

  // Joint safety is judged over passed units only: a failed or skipped unit's coverage and kills
  // are not trusted (A1), so they never stand in for a retired unit (ENGINE-NOTES).
  const trusted = model.units.filter((u) => u.status === 'passed');
  const trustedKilled = model.mutants.filter(
    (m) => m.detected && trusted.some((t) => m.killerUnits.has(t.id)),
  );

  const removed = new Set();
  const accepted = [];
  for (const c of candidates) {
    const trial = new Set(removed).add(c.u.id);
    const trialAccepted = [...accepted, c];
    const remaining = trusted.filter((u) => !trial.has(u.id));
    // 1. Lines: the removed units' own lines are still covered by remaining units, or by setup
    //    lines of a test file that still has a unit.
    const liveFiles = new Set(model.units.filter((u) => !trial.has(u.id)).map((u) => u.file));
    const setupLeft = mapUnionAll([...model.setup].filter(([f]) => liveFiles.has(f)).map(([, m]) => m));
    const coveredLeft = mapUnion(mapUnionAll(remaining.map((u) => u.own)), setupLeft);
    const removedOwn = mapUnionAll(trialAccepted.map((x) => x.u.own));
    let ok = mapSubset(removedOwn, coveredLeft);
    // 2. Mutants: every detected mutant with a trusted killer still has one that remains.
    if (ok) ok = trustedKilled.every((m) => remaining.some((t) => m.killerUnits.has(t.id)));
    // 3. Duplicates: every accepted duplicate-path unit still has a qualifying v that remains.
    if (ok) ok = trialAccepted.every((x) => !x.duplicatePath || x.dups.some((v) => !trial.has(v.id)));
    if (ok) {
      removed.add(c.u.id);
      accepted.push(c);
    } else {
      c.u.hints.push('retire-conflict');
    }
  }
  for (const c of accepted) {
    const u = c.u;
    u.advice = 'retire';
    u.reasons = ['no-unique-lines'];
    if (c.mutationPath) u.reasons.push('no-unique-kills');
    if (c.duplicatePath) {
      u.reasons.push('duplicate-of');
      u.duplicateOf = c.dups.filter((v) => !removed.has(v.id)).map((v) => v.id).sort(cmp)[0];
    }
  }
}

/** Per-file unique lines at file granularity (A12): [{ file, uniqueLines, hints }]. */
export function fileSummaries(model) {
  if (!model.fileLevel) return undefined;
  const files = sortedUnique([...model.units.map((u) => u.file), ...model.byFile.keys()]);
  const own = files.map((f) => {
    const rows = model.units.filter((u) => u.file === f).flatMap((u) => u.rows);
    const raw = mapUnionAll([model.byFile.get(f) ?? new Map(), ...rows.map((r) => model.byTest.get(r) ?? new Map())]);
    return mapDiff(raw, model.setup.get(f) ?? new Map());
  });
  const exclusive = exclusiveLines(own);
  return files.map((file, i) => {
    const uniqueLines = mapSize(mapDiff(exclusive[i], model.allSetup));
    return { file, uniqueLines, hints: uniqueLines === 0 ? ['file-no-unique-coverage'] : [] };
  });
}
