// V1-V5: deterministic evidence for an agent to inspect before changing tests.
import { cmp, sortedUnique } from './order.mjs';
import { mapIntersect, mapSize, mapSubset, mapToObject } from './lines.mjs';
import { analyzePseudo } from '../analysis/pseudo.mjs';
import { analyseReviewAssertions } from '../analysis/assertions.mjs';

export const NOTICE = "No unique evidence is not proof that a test is redundant. Read each candidate's assertions; a proposed removal or merge must pass guard before it is committed. Cupel never advises removal.";
const PRIORITY = ['same-shape-group', 'no-unique-evidence', 'brittle', 'pseudo-test', 'never-passes'];

function overlaps(model, unit, killSets) {
  const ownKills = killSets.get(unit.id);
  return model.units.filter((other) => other !== unit).map((other) => {
    const sharedLines = mapSize(mapIntersect(unit.own, other.own));
    const otherKills = killSets.get(other.id);
    const sharedKills = [...ownKills].filter((id) => otherKills.has(id)).length;
    return { unit: other.id, sharedLines, sharedKills,
      coversAllOf: mapSubset(unit.own, other.own) && [...ownKills].every((id) => otherKills.has(id)) };
  }).filter((entry) => entry.sharedLines || entry.sharedKills)
    .sort((a, b) => b.sharedLines - a.sharedLines || b.sharedKills - a.sharedKills || cmp(a.unit, b.unit)).slice(0, 5);
}

export function reviewSection(model, args, sidecar) {
  const pseudo = model.input.functionSites ? analyzePseudo(model.input, model.input.functionSites) : null;
  const pseudoByUnit = new Map(pseudo?.units.map((u) => [u.id, u]) ?? []);
  const assertions = sidecar ? new Map(analyseReviewAssertions(model.input, sidecar).map((u) => [u.id, u])) : null;
  const groups = new Map(model.groups.map((g) => [g.id, g]));
  const killSets = new Map(model.units.map((u) => [u.id, new Set()]));
  for (const mutant of model.mutants) if (mutant.detected) {
    for (const id of mutant.killerUnits) killSets.get(id).add(mutant.id);
  }
  const selected = args.units ? new Set(args.units.flatMap((name) =>
    model.units.filter((u) => u.id === name || u.rows.includes(name) || u.file === name).map((u) => u.id))) : null;
  const eligible = [];
  for (const u of model.units) {
    if (selected && !selected.has(u.id)) continue;
    const observed = pseudoByUnit.get(u.id);
    const reasons = PRIORITY.filter((reason) => ({
      'same-shape-group': !!u.group,
      'no-unique-evidence': u.hints.includes('no-unique-evidence'),
      brittle: u.brittle.length > 0,
      'pseudo-test': observed?.pseudoTest === true,
      'never-passes': u.status !== 'passed' && u.rowTests.every((row) => row.runStatuses?.length > 0 && row.runStatuses.every((status) => status !== 'passed')),
    })[reason]);
    if (!reasons.length) continue;
    eligible.push({ unit: u, reasons });
  }
  eligible.sort((a, b) => Number(a.unit.tier === 'critical') - Number(b.unit.tier === 'critical') ||
    PRIORITY.indexOf(a.reasons[0]) - PRIORITY.indexOf(b.reasons[0]) || cmp(a.unit.id, b.unit.id));
  const candidates = eligible.slice(0, args.limit ?? 50).map(({ unit: u, reasons }) => {
    const observed = pseudoByUnit.get(u.id);
    const group = u.group ? { id: u.group, members: groups.get(u.group).units } : null;
    const evidence = {
      ownLines: mapToObject(u.own), uniqueLines: u.unique === null ? null : mapToObject(u.unique),
      kills: u.kills, uniqueKills: u.uniqueKills, overlaps: overlaps(model, u, killSets), group, brittle: u.brittle,
    };
    if (observed) evidence.pseudoTestedFunctions = sortedUnique(observed.pseudoTestedFunctions);
    if (assertions?.has(u.id)) {
      const a = assertions.get(u.id);
      evidence.assertions = { assertionCount: a.assertionCount, fingerprints: a.fingerprints,
        uniqueFingerprints: a.uniqueFingerprints, incomplete: a.incomplete, capHit: a.capHit,
        assertionFree: a.assertionFree, subsumedBy: a.subsumedBy, cloneOf: a.cloneOf };
    }
    return { unit: u.id, file: u.file, tier: u.tier, tierReason: u.tierReason,
      status: u.status, reasons, evidence, guardRequired: true };
  });
  return { notice: NOTICE, candidates, critical: candidates.filter((c) => c.tier === 'critical').length };
}
