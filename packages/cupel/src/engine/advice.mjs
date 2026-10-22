// Advice (SPEC section 7): A1-A12, consolidation groups (A9) and review candidates (A10). Pure.

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

  for (const u of reachA10) {
    u.advice = 'keep';
    if (isReviewCandidate(u, model, cfg)) {
      u.hints.push('no-unique-evidence'); // A10
      const duplicate = duplicatesOf(u, model, cfg)[0];
      if (duplicate) u.duplicateOf = duplicate.id;
    } else u.hints.push('no-unique-coverage-unverified'); // A11
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

function isReviewCandidate(u, model, cfg) {
  if (u.protected || u.e2e || u.spawnsInterpreter || !u.rechecked || u.uniqueLines !== 0) return false;
  const passedOthers = model.units.filter((v) => v !== u && v.status === 'passed');
  const covered = mapUnion(mapUnionAll(passedOthers.map((v) => v.own)), model.allSetup);
  if (!mapSubset(u.own, covered)) return false;
  return (model.mutation !== null && u.targeted && u.uniqueKills === 0) || duplicatesOf(u, model, cfg).length > 0;
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
