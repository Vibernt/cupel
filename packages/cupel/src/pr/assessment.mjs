import { cmp } from '../engine/order.mjs';
import { diff, format, parse } from '../engine/lines.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort(cmp);
const identity = row => ({ id: row.id, file: row.file, name: row.name,
  tags: sorted(row.tags ?? []) });
const containsLine = (value, line) => {
  const parsed = parse(value);
  if (parsed.malformed || parsed.bad.length)
    throw new Error('Node PR changed base line evidence malformed');
  return parsed.set.some(([first, last]) => first <= line && line <= last);
};

/** Assess only the declared PR scope. This is never a whole-suite guard result. */
export function assessNodeProfileRequest({ baseline, head, decision, sites, mutation,
  lineSides = {} }) {
  if (!baseline?.collection?.input || !head?.input || !decision ||
      !Array.isArray(sites) || (sites.length && mutation?.kind !== 'complete'))
    throw new Error('Node PR assessment requires complete scoped evidence');
  if (decision.changedCriticalTests.length &&
      (!baseline.collection.input.coverage?.byTest || !head.input.coverage?.byTest))
    throw new Error('Node PR edited critical test coverage evidence missing');
  const full = baseline.collection.input.tests;
  const selected = new Set(decision.files);
  const changedTests = new Set(decision.changed.filter(path =>
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)));
  const headById = new Map(head.input.tests.map(row => [row.id, row]));
  const identityLosses = [];
  for (const old of full) {
    if (!selected.has(old.file)) continue;
    const current = headById.get(old.id);
    const critical = decision.changedCriticalTests.includes(old.file);
    if ((!changedTests.has(old.file) || critical) &&
        (!current || !same(identity(old), identity(current))))
      identityLosses.push(old.id);
    if (old.status === 'passed' && current?.status === 'skipped')
      throw new Error(`Node PR previously passing selected test is now skipped: ${old.id}`);
  }
  if (identityLosses.length)
    throw new Error(`Node PR selected test identity or critical tag changed: ${identityLosses.join(', ')}`);
  const headIds = new Set(head.input.tests.map(row => row.id));
  if (headIds.size !== head.input.tests.length ||
      head.input.tests.some(row => !selected.has(row.file)))
    throw new Error('Node PR selected input has duplicate or foreign tests');
  const failed = sorted(head.input.tests.filter(row => row.status === 'failed').map(row => row.id));
  const lostCoverage = [];
  for (const old of full) {
    if (!decision.changedCriticalTests.includes(old.file)) continue;
    if (old.status === 'passed' &&
        (!Object.hasOwn(baseline.collection.input.coverage.byTest, old.id) ||
         !Object.hasOwn(head.input.coverage.byTest, old.id)))
      throw new Error(`Node PR edited critical test coverage row missing: ${old.id}`);
    for (const [source, oldLines] of Object.entries(
      baseline.collection.input.coverage.byTest?.[old.id] ?? {})) {
      if (baseline.collection.input.sources[source]?.hash !== head.input.sources[source]?.hash)
        continue;
      const oldParsed = parse(oldLines);
      const nowParsed = parse(head.input.coverage.byTest?.[old.id]?.[source] ?? '');
      if (oldParsed.malformed || oldParsed.bad.length || nowParsed.malformed || nowParsed.bad.length)
        throw new Error('Node PR critical test coverage evidence malformed');
      const lost = diff(oldParsed.set, nowParsed.set);
      if (lost.length) lostCoverage.push({ test: old.id, source, lines: format(lost) });
    }
  }
  const oldMutants = new Map((baseline.critical.mutation?.mutants ?? []).map(row => [row.id, row]));
  const current = new Map((mutation?.mutants ?? []).map(row => [row.id, row]));
  if (new Set(sites.map(site => site.id)).size !== sites.length ||
      sites.some(site => !current.has(site.id)) || current.size !== sites.length)
    throw new Error('Node PR scoped mutation site inventory is incomplete');
  if ([...current.values()].some(row => !['killed', 'survived'].includes(row.status)))
    throw new Error('Node PR scoped critical mutant has no executed coverage');
  const comparable = [], newOrChanged = [], lostKills = [], lostKillers = [];
  const oldTests = new Map(full.map(row => [row.id, row]));
  for (const site of sites) {
    const old = oldMutants.get(site.id), now = current.get(site.id);
    if (!old || old.source !== site.source || old.line !== site.line ||
        old.operator !== site.operator) {
      newOrChanged.push(site.id); continue;
    }
    comparable.push(site.id);
    if (old.status === 'killed' && now.status !== 'killed') lostKills.push(site.id);
    for (const testId of old.killedBy ?? [])
      if (selected.has(oldTests.get(testId)?.file) &&
          !(now.killedBy ?? []).includes(testId))
        lostKillers.push({ mutant: site.id, test: testId });
  }
  // An edited critical test may remove all coverage for an unchanged source.
  // The absence of its prior kill is a loss, never an apparent improvement.
  if (decision.changedCriticalTests.length)
    for (const old of baseline.critical.mutation?.mutants ?? [])
      if (old.status === 'killed' && !current.has(old.id) &&
          baseline.git.inputManifest[old.source] === head.input.sources[old.source]?.hash)
        lostKills.push(old.id);
  for (const old of baseline.critical.mutation?.mutants ?? []) {
    if (old.status !== 'killed' || current.has(old.id) ||
        !Object.hasOwn(lineSides, old.source)) continue;
    if (containsLine(lineSides[old.source].base, old.line))
      throw new Error(`Node PR changed critical source lost a previously killed baseline site: ${old.id}`);
  }
  const regressions = sorted(new Set(lostKills));
  return { exit: failed.length || regressions.length || lostKillers.length ||
      lostCoverage.length ? 1 : 0,
    tests: { executed: head.input.tests.length, failed },
    lostCoverage: lostCoverage.sort((a, b) => cmp(a.test, b.test) || cmp(a.source, b.source)),
    mutation: { scopedSites: sites.length, comparable: sorted(comparable),
      newOrChanged: sorted(newOrChanged), lostKills: regressions,
      lostKillers: lostKillers.sort((a, b) => cmp(a.mutant, b.mutant) || cmp(a.test, b.test)),
      killed: mutation?.mutants.filter(row => row.status === 'killed').length ?? 0,
      survived: mutation?.mutants.filter(row => row.status === 'survived').length ?? 0,
      noCoverage: mutation?.mutants.filter(row => row.status === 'no-coverage').length ?? 0 } };
}
