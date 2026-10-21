#!/usr/bin/env node
// S9: test the three history hypotheses against S6's advice and hand-checks, and measure what squash merges and
// shallow clones lose. Writes results/h1.json, h2.json, h3.json, history.json and prints a summary.
//
// Usage: node plans/spikes/s9/analyse.mjs
//
// Units are S6 sites (a test definition: file and title line); rows of a parametrized test share one. A site's
// introducing commit comes from sites.mjs. The root commit of each history is an import, so it is never a fix
// commit here (Assay's root subject says "fix runner portability" but imports 79 tests).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSuite } from './sites.mjs';
import { SUITES, loadS6, readJson, fisher, binomUpper, rate, shingles, jaccard, isMerge } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const S6R = join(HERE, '../s6/results');
const hand = { assay: readJson(join(S6R, 'handcheck-assay.json')), cc: readJson(join(S6R, 'handcheck-cc.json')) };
const out = { h1: {}, h2: {}, h3: {}, history: {} };
const SMALL = 5;

const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

for (const suite of Object.keys(SUITES)) {
  const { log, commits, sites } = buildSuite(suite);
  const S6 = loadS6(suite);
  const bySite = new Map(sites.map((s) => [s.site, s]));
  // Modes: 'subject' (subject matches), 'any' (subject or body), 'small' (subject matches and the commit introduced at
  // most SMALL test sites: a fix with its regression tests rather than a bulk import or feature that names a fix).
  const fixOf = (sha, mode) => {
    const c = commits.get(sha);
    if (!c || c.root) return false;
    if (mode === 'subject') return c.fixSubject;
    if (mode === 'small') return c.fixSubject && c.sites <= SMALL;
    if (mode === 'smallAny') return c.fixAny && c.sites <= SMALL;
    return c.fixAny;
  };
  const siteOf = (id) => S6.siteOfUnit(id) ?? S6.siteOfTest.get(id);

  // ------------------------------------------------------------------ H1: fix commits and retire advice
  const v1Units = S6.v1.tests.map((u) => ({ u, site: siteOf(u.id) })).filter((x) => x.site && bySite.has(x.site));
  const allSites = [...new Set(v1Units.map((x) => x.site))];
  const setOf = (pred) => [...new Set(v1Units.filter((x) => pred(x.u)).map((x) => x.site))];
  const v0RetireSites = [...new Set(S6.v0.tests.filter((t) => t.advice === 'retire').map((t) => siteOf(t.id)).filter((s) => s && bySite.has(s)))];
  const groups = {
    'all units (base)': allSites,
    'v0 retire advice (coverage only)': v0RetireSites,
    'v1 unverified retire (kept, marked)': setOf((u) => u.reasons.some((r) => r.startsWith('unverified:'))),
    'v1 keep: has a unique line': setOf((u) => u.signals.uniqueLines >= 1),
    'v1 critical': setOf((u) => u.tier === 'critical'),
    'v1 no coverage evidence': setOf((u) => u.reasons.some((r) => r.startsWith('no coverage evidence'))),
  };
  const rowsFor = (siteList, mapField = 'intro', excludeAmbiguous = false) => {
    const xs = siteList.map((k) => bySite.get(k)).filter((s) => s && s[mapField] && !(excludeAmbiguous && s.ambiguous));
    return { n: xs.length, fixSubject: xs.filter((s) => fixOf(s[mapField], 'subject')).length, fixAny: xs.filter((s) => fixOf(s[mapField], 'any')).length,
      fixSmall: xs.filter((s) => fixOf(s[mapField], 'small')).length, fixSmallAny: xs.filter((s) => fixOf(s[mapField], 'smallAny')).length };
  };
  const h1 = { groups: {}, sensitivity: {}, judged: [] };
  const base = rowsFor(allSites);
  for (const [name, list] of Object.entries(groups)) {
    const r = rowsFor(list);
    const restS = base.fixSubject - r.fixSubject, restA = base.fixAny - r.fixAny, restN = base.n - r.n, restM = base.fixSmall - r.fixSmall;
    h1.groups[name] = {
      ...r, rateSubject: rate(r.fixSubject, r.n), rateAny: rate(r.fixAny, r.n), rateSmall: rate(r.fixSmall, r.n), rateSmallAny: rate(r.fixSmallAny, r.n),
      pSmallVsRest: name.includes('base') ? null : +fisher(r.fixSmall, r.n - r.fixSmall, restM, restN - restM).toPrecision(3),
      pSubjectVsRest: name.includes('base') ? null : +fisher(r.fixSubject, r.n - r.fixSubject, restS, restN - restS).toPrecision(3),
      pAnyVsRest: name.includes('base') ? null : +fisher(r.fixAny, r.n - r.fixAny, restA, restN - restA).toPrecision(3),
    };
    h1.sensitivity[name] = { oldestLine: rowsFor(list, 'oldest'), unambiguousOnly: rowsFor(list, 'intro', true) };
  }
  // Judged retire items (all rounds; ids deduplicated, a later round's judgement of the same id is kept once).
  const seen = new Set();
  for (const x of hand[suite]) {
    if (x.class !== 'retire' || seen.has(x.id)) continue;
    seen.add(x.id);
    const s = bySite.get(siteOf(x.id));
    const c = s && commits.get(s.intro);
    h1.judged.push({ round: x.round, id: x.id, judgement: x.judgement, fp: x.fp, site: s?.site ?? null, intro: s?.intro?.slice(0, 10) ?? null,
      introSubject: c?.subject ?? null, fixSubject: s ? fixOf(s.intro, 'subject') : null, fixAny: s ? fixOf(s.intro, 'any') : null, fixSmall: s ? fixOf(s.intro, 'small') : null, flags: s?.flags ?? null, batch: c?.sites ?? null });
  }
  const jw = h1.judged.filter((j) => j.judgement !== 'correct' && j.site), jc = h1.judged.filter((j) => j.judgement === 'correct' && j.site);
  h1.judgedSummary = {
    wrongOrDebatable: { n: jw.length, fixSubject: jw.filter((j) => j.fixSubject).length, fixAny: jw.filter((j) => j.fixAny).length, fixSmall: jw.filter((j) => j.fixSmall).length },
    correct: { n: jc.length, fixSubject: jc.filter((j) => j.fixSubject).length, fixAny: jc.filter((j) => j.fixAny).length, fixSmall: jc.filter((j) => j.fixSmall).length },
    pWrongVsBaseSmall: +binomUpper(jw.filter((j) => j.fixSmall).length, jw.length, base.fixSmall / base.n).toPrecision(3),
    pWrongVsBaseSubject: +binomUpper(jw.filter((j) => j.fixSubject).length, jw.length, base.fixSubject / base.n).toPrecision(3),
    pWrongVsBaseAny: +binomUpper(jw.filter((j) => j.fixAny).length, jw.length, base.fixAny / base.n).toPrecision(3),
  };
  out.h1[suite] = h1;

  // ------------------------------------------------------------------ H2: batches and same-shape consolidation
  const shp = new Map(sites.map((s) => [s.site, shingles(s.shape)]));
  const filesSites = new Map();
  for (const k of allSites) { const s = bySite.get(k); if (!filesSites.has(s.file)) filesSites.set(s.file, []); filesSites.get(s.file).push(s); }
  let pairs = 0, same = 0, hi = 0, hiSame = 0, mid = 0, midSame = 0, agentSamePairs = 0;
  const shapeBins = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1.01];
  const bins = shapeBins.slice(0, -1).map((lo, i) => ({ lo, hi: shapeBins[i + 1], pairs: 0, sameCommit: 0 }));
  for (const list of filesSites.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const sc = a.intro === b.intro;
      const sim = jaccard(shp.get(a.site), shp.get(b.site));
      pairs++; if (sc) { same++; if (commits.get(a.intro)?.agent) agentSamePairs++; }
      if (sim >= 0.8) { hi++; if (sc) hiSame++; } else if (sim >= 0.5) { mid++; if (sc) midSame++; }
      const bin = bins.find((x) => sim >= x.lo && sim < x.hi); bin.pairs++; if (sc) bin.sameCommit++;
    }
  }
  // S6 v1 same-shape pairs and their clusters (connected components), with the hand judgement of any member.
  const v1Cons = S6.v1.tests.filter((u) => u.advice === 'consolidate' && u.signals.shapeSibling);
  const pairKey = (a, b) => [a, b].sort().join(' | ');
  const v1Pairs = new Map();
  for (const u of v1Cons) v1Pairs.set(pairKey(u.id, u.signals.shapeSibling), [u.id, u.signals.shapeSibling]);
  const judgeOf = new Map(hand[suite].filter((x) => x.class === 'consolidate' && x.round === 'v1').map((x) => [x.id, x.judgement]));
  const parent = new Map(); const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const [a, b] of v1Pairs.values()) { for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x); parent.set(find(a), find(b)); }
  const clusters = new Map();
  for (const x of parent.keys()) { const r = find(x); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(x); }
  const clusterRows = [...clusters.values()].map((ids) => {
    ids.sort();
    const ss = ids.map((id) => bySite.get(siteOf(id)));
    const intros = [...new Set(ss.map((s) => s?.intro))];
    const js = ids.map((id) => judgeOf.get(id)).filter(Boolean);
    const judgement = js.includes('correct') ? 'correct' : js.includes('debatable') ? 'debatable' : js.includes('wrong') ? 'wrong' : 'unjudged';
    const c = commits.get(intros[0]);
    return { ids, judgement, oneCommit: intros.length === 1, intros: intros.map((x) => x?.slice(0, 10)), agent: intros.map((x) => commits.get(x)?.agent ?? null),
      introSubject: intros.length === 1 ? c?.subject : null, batch: intros.length === 1 ? c?.sites : null, flags: ss.map((s) => s?.flags) };
  });
  // v0 "subset of a sibling" / "Jaccard" consolidations (all judged wrong in the hand-check), as pairs.
  const v0Pairs = [];
  for (const t of S6.v0.tests.filter((x) => x.advice === 'consolidate')) {
    const sib = t.reasons[0].startsWith('lines are a subset') ? t.signals.subsetOf : t.signals.nearest;
    const a = bySite.get(siteOf(t.id)), b = bySite.get(siteOf(sib));
    if (a && b && a.site !== b.site) v0Pairs.push(a.intro === b.intro);
  }
  const v0Judged = [];
  for (const x of hand[suite].filter((y) => y.class === 'consolidate' && y.round === 'v0')) {
    const t = S6.v0.tests.find((y) => y.id === x.id);
    if (!t) continue;
    const sib = t.reasons[0].startsWith('lines are a subset') ? t.signals.subsetOf : t.signals.nearest;
    const a = bySite.get(siteOf(t.id)), b = bySite.get(siteOf(sib));
    if (a && b) v0Judged.push({ id: x.id, judgement: x.judgement, sameSite: a.site === b.site, oneCommit: a.intro === b.intro });
  }
  // Batch size and agent authorship of each site's introducing commit.
  const siteList = allSites.map((k) => bySite.get(k));
  const batchSizes = siteList.map((s) => commits.get(s.intro)?.sites ?? 0);
  const agentSites = siteList.filter((s) => commits.get(s.intro)?.agent).length;
  const nonMerge = log.filter((c) => !isMerge(c));
  const agentCommits = nonMerge.filter((c) => commits.get(c.sha).agent).length;
  const correctClusters = clusterRows.filter((c) => c.judgement === 'correct');
  const sameRate = same / pairs;
  out.h2[suite] = {
    sameFilePairs: { pairs, sameCommit: same, rate: rate(same, pairs), sameCommitAgent: agentSamePairs },
    byShape: bins.map((b) => ({ shape: `${b.lo}–${b.hi > 1 ? 1 : b.hi}`, pairs: b.pairs, sameCommit: b.sameCommit, rate: rate(b.sameCommit, b.pairs) })),
    shapeAtLeast08: { pairs: hi, sameCommit: hiSame, rate: rate(hiSame, hi), pVsOtherPairs: +fisher(hiSame, hi - hiSame, same - hiSame, pairs - hi - (same - hiSame)).toPrecision(3) },
    v1Clusters: clusterRows,
    correctClusters: { n: correctClusters.length, oneCommit: correctClusters.filter((c) => c.oneCommit).length, pVsSameFileRate: +binomUpper(correctClusters.filter((c) => c.oneCommit).length, correctClusters.length, sameRate).toPrecision(3) },
    allV1Clusters: { n: clusterRows.length, oneCommit: clusterRows.filter((c) => c.oneCommit).length },
    v0ConsolidatePairs: { n: v0Pairs.length, oneCommit: v0Pairs.filter(Boolean).length, rate: rate(v0Pairs.filter(Boolean).length, v0Pairs.length) },
    v0Judged,
    batches: { introCommits: new Set(siteList.map((s) => s.intro)).size, medianBatchPerSite: median(batchSizes), sitesInBatchesOf10Plus: batchSizes.filter((b) => b >= 10).length, sites: siteList.length },
    agent: { nonMergeCommits: nonMerge.length, agentCommits, agentRate: rate(agentCommits, nonMerge.length), sitesFromAgentCommits: agentSites, sitesRate: rate(agentSites, siteList.length),
      byAgent: Object.fromEntries([...new Set(nonMerge.map((c) => commits.get(c.sha).agent))].map((a) => [a ?? 'none', nonMerge.filter((c) => commits.get(c.sha).agent === a).length])) },
  };

  // ------------------------------------------------------------------ H3: co-change of test lines with copy, CSS, docs
  // A site's later edits are the blame commits of its body lines other than its introducing commit.
  const kindsOf = (s) => (s.bodyShas ?? []).filter((x) => x !== s.intro).map((x) => commits.get(x)?.kind ?? 'unknown');
  const pinStats = (list) => {
    const n = list.length;
    const edited = list.filter((s) => kindsOf(s).length);
    const presEdit = list.filter((s) => kindsOf(s).some((k) => k === 'presentation'));
    const presUiEdit = list.filter((s) => kindsOf(s).some((k) => k === 'presentation' || k === 'ui'));
    const onlyNonLogic = edited.filter((s) => kindsOf(s).every((k) => k !== 'logic'));
    const introPres = list.filter((s) => ['presentation', 'ui'].includes(commits.get(s.intro)?.kind));
    return { n, edited: edited.length, editedPresentation: presEdit.length, editedPresentationOrUi: presUiEdit.length, editedNeverWithLogic: onlyNonLogic.length, introPresentationOrUi: introPres.length };
  };
  const flagged = new Set();
  for (const u of S6.v1.tests) if (u.signals.brittle?.length) { const k = siteOf(u.id); if (k) flagged.add(k); }
  const pinned = siteList.filter((s) => flagged.has(s.site)), unpinned = siteList.filter((s) => !flagged.has(s.site));
  const P = pinStats(pinned), U = pinStats(unpinned);
  const judgedRewrite = [];
  const seenR = new Set();
  for (const x of hand[suite]) {
    if (x.class !== 'rewrite' || seenR.has(x.id) || /slow/.test(x.reasons.join(' '))) continue;
    seenR.add(x.id);
    const s = bySite.get(siteOf(x.id));
    if (!s) { judgedRewrite.push({ id: x.id, judgement: x.judgement, site: null }); continue; }
    const ks = kindsOf(s);
    judgedRewrite.push({ id: x.id, round: x.round, judgement: x.judgement, fp: x.fp, edits: ks.length, editKinds: ks, introKind: commits.get(s.intro)?.kind,
      presentationEdit: ks.some((k) => k === 'presentation' || k === 'ui'), neverWithLogic: ks.length > 0 && ks.every((k) => k !== 'logic') });
  }
  const jr = (j) => judgedRewrite.filter((x) => x.site !== null && x.judgement === j);
  const sumJ = (xs) => ({ n: xs.length, edited: xs.filter((x) => x.edits).length, presentationEdit: xs.filter((x) => x.presentationEdit).length, neverWithLogic: xs.filter((x) => x.neverWithLogic).length, introPresentationOrUi: xs.filter((x) => ['presentation', 'ui'].includes(x.introKind)).length });
  // Control: UI test files only (tests/ui-*), where any test is edited with console pages, pinned or not.
  const isUiTest = (s) => /^tests\/ui-/.test(s.file);
  const PC = pinStats(pinned.filter(isUiTest)), UC = pinStats(unpinned.filter(isUiTest));
  // Precision of the history signal as a pin finder: of sites edited in a presentation or UI commit, how many are flagged.
  out.h3[suite] = {
    pinned: P, unpinned: U, uiFilesPinned: PC, uiFilesUnpinned: UC,
    pUiFilesEditedPresentationOrUi: +fisher(PC.editedPresentationOrUi, PC.n - PC.editedPresentationOrUi, UC.editedPresentationOrUi, UC.n - UC.editedPresentationOrUi).toPrecision(3),
    pJudgedCorrectVsWrong: +fisher(sumJ(jr('correct')).presentationEdit, sumJ(jr('correct')).n - sumJ(jr('correct')).presentationEdit, sumJ(jr('wrong')).presentationEdit, sumJ(jr('wrong')).n - sumJ(jr('wrong')).presentationEdit).toPrecision(3),
    pEditedPresentationOrUi: +fisher(P.editedPresentationOrUi, P.n - P.editedPresentationOrUi, U.editedPresentationOrUi, U.n - U.editedPresentationOrUi).toPrecision(3),
    pIntroPresentationOrUi: +fisher(P.introPresentationOrUi, P.n - P.introPresentationOrUi, U.introPresentationOrUi, U.n - U.introPresentationOrUi).toPrecision(3),
    judged: { correct: sumJ(jr('correct')), wrong: sumJ(jr('wrong')), debatable: sumJ(jr('debatable')) },
    judgedItems: judgedRewrite,
    commitKinds: Object.fromEntries(['logic', 'ui', 'presentation', 'data', 'test-only'].map((k) => [k, log.filter((c) => !isMerge(c) && commits.get(c.sha).kind === k).length])),
  };

  // ------------------------------------------------------------------ history shape: squash look, simulated squash merge, shallow clone
  const parentsOf = new Map(log.map((c) => [c.sha, c.parents]));
  const ancestors = (start, stopSet) => { const seenA = new Set(); const st = [start]; while (st.length) { const x = st.pop(); if (!x || seenA.has(x) || stopSet.has(x) || !parentsOf.has(x)) continue; seenA.add(x); for (const p of parentsOf.get(x)) st.push(p); } return seenA; };
  const head = log[0].sha;
  // First-parent chain from HEAD.
  const chain = []; for (let x = head; x; x = parentsOf.get(x)?.[0]) chain.push(x);
  const chainSet = new Set(chain);
  // Every commit's squash target: the first-parent commit (a merge, under squash: one commit per merged branch) that brought it in.
  const squashTo = new Map();
  for (const m of chain) {
    squashTo.set(m, m);
    const ps = parentsOf.get(m);
    if (ps.length < 2) continue;
    const firstSide = ancestors(ps[0], new Set());
    for (const p of ps.slice(1)) for (const x of ancestors(p, firstSide)) if (!squashTo.has(x)) squashTo.set(x, m);
  }
  const squashed = siteList.filter((s) => squashTo.get(s.intro) !== s.intro);
  const sqBatch = new Map(); for (const s of siteList) { const t = squashTo.get(s.intro) ?? s.intro; sqBatch.set(t, (sqBatch.get(t) ?? 0) + 1); }
  // Under squash, the commit message is the merge's (PR title or branch, and the merge body); fix if that matches.
  const sqFixAny = siteList.filter((s) => { const c = commits.get(squashTo.get(s.intro) ?? s.intro); return c && !c.root && c.fixAny; }).length;
  // Shallow clone: graph distance from HEAD (all parents), as `git clone --depth`.
  const dist = new Map([[head, 0]]); const q = [head];
  while (q.length) { const x = q.shift(); for (const p of parentsOf.get(x) ?? []) if (!dist.has(p)) { dist.set(p, dist.get(x) + 1); q.push(p); } }
  const shallow = Object.fromEntries([1, 10, 50, 100, 200, 500].map((d) => [d, siteList.filter((s) => (dist.get(s.intro) ?? Infinity) >= d).length]));
  const sq = log.filter((c) => !isMerge(c)).map((c) => commits.get(c.sha).squash);
  out.history[suite] = {
    commits: log.length, merges: log.filter(isMerge).length, firstParentChain: chain.length, nonMergeOnChain: chain.filter((x) => parentsOf.get(x).length < 2).length,
    squashLook: { nonMerge: sq.length, prSuffix: sq.filter((x) => x.pr).length, bulletList2plus: sq.filter((x) => x.bullets >= 2).length, squashed: sq.filter((x) => x.squashed).length, multiCoauthor: sq.filter((x) => x.coauthors >= 2).length },
    bigCommits: { files20plus: log.filter((c) => !isMerge(c) && c.files.length >= 20).length, introduces10plusTests: [...commits.values()].filter((c) => c.sites >= 10).length },
    simulatedSquash: { sitesWhoseIntroIsFolded: squashed.length, sites: siteList.length, introCommitsBefore: new Set(siteList.map((s) => s.intro)).size, introCommitsAfter: sqBatch.size,
      medianBatchBefore: median(siteList.map((s) => commits.get(s.intro).sites)), medianBatchAfter: median(siteList.map((s) => sqBatch.get(squashTo.get(s.intro) ?? s.intro))),
      fixAnyBefore: siteList.filter((s) => fixOf(s.intro, 'any')).length, fixAnyAfterMergeMessageOnly: sqFixAny,
      fixSubjectBefore: siteList.filter((s) => fixOf(s.intro, 'subject')).length,
      fixSubjectAfterMergeMessageOnly: siteList.filter((s) => { const c = commits.get(squashTo.get(s.intro) ?? s.intro); return c && !c.root && c.fixSubject; }).length },
    shallowSitesOutsideDepth: shallow, maxDepth: Math.max(...dist.values()),
  };
}

writeFileSync(join(HERE, 'results/h1.json'), JSON.stringify(out.h1, null, 1));
writeFileSync(join(HERE, 'results/h2.json'), JSON.stringify(out.h2, null, 1));
writeFileSync(join(HERE, 'results/h3.json'), JSON.stringify(out.h3, null, 1));
writeFileSync(join(HERE, 'results/history.json'), JSON.stringify(out.history, null, 1));
for (const suite of Object.keys(SUITES)) {
  console.log(`\n=== ${suite}`);
  console.log('H1 groups', JSON.stringify(out.h1[suite].groups, null, 0));
  console.log('H1 judged', JSON.stringify(out.h1[suite].judgedSummary));
  const h2 = { ...out.h2[suite] }; delete h2.v1Clusters; delete h2.v0Judged;
  console.log('H2', JSON.stringify(h2));
  const h3 = { ...out.h3[suite] }; delete h3.judgedItems;
  console.log('H3', JSON.stringify(h3));
  console.log('history', JSON.stringify(out.history[suite]));
}
