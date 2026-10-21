// S6 draft advice engine (spike quality, deterministic). Pure: no I/O, no clock, no randomness, no node: imports.
//
// Usage (library): import { advise } from './engine.mjs'; const report = advise(input, config);
// `input` is what build-input.mjs writes; `config` is config.json (v0) or config-tuned.json (v1).
// advise.mjs is the CLI wrapper that reads and writes files.
//
// Signals per test (lines are 'path:line' indices; setup lines, i.e. module load, root hooks, between-test and
// teardown segments of any file, are removed from every test first, as in S2):
//   own           the test's lines minus setup lines
//   uniqueLines   own lines that no other test covers
//   uniqueKills   mutants killed by this test and by no other test (and by no file whose kill is not attributed
//                 to a named test, such as a timeout)
//   evidence      'mutation+coverage' when the test's own lines touch a mutated file, else 'coverage-only'
//   tier          critical | standard | minor (config.critical, config.minor)
//   brittle       detector flags (detect-js.mjs, detect_py.py)
//   ms            the test's duration in the coverage run
//   subsetOf      the smallest same-file sibling whose own lines contain this test's own lines
//   nearest       the same-file sibling with the highest Jaccard similarity of own lines
//
// Advice, first rule that applies wins:
//   1. brittle (any configured kind)                                  -> rewrite  (pins to behaviour assertions)
//   2. critical tier                                                  -> keep     (never retire)
//   3. uniqueLines >= keep.uniqueLines or uniqueKills >= keep.uniqueKills:
//        slow (ms >= slowMs) and uniqueLines < lowValueUniqueLines and no unique kill -> rewrite (move down a layer)
//        otherwise                                                    -> keep
//   4. spawns an interpreter (its coverage is partly invisible)        -> keep     (coverage partial)
//   5. own is empty                                                   -> retire   (covers nothing beyond setup)
//   6. own is a subset of a sibling's own, or Jaccard >= jaccard      -> consolidate (into that sibling)
//   7. otherwise                                                      -> retire   (every line is covered elsewhere)
//   A retire candidate with a per-process re-check (recheckLines, D7) that shows a line no other test covers
//   becomes keep.
// File groups (separate list): test files whose primary target source file is the same, and whose names are
// prefixes of one another (ui-pipelines, ui-pipelines-v2), -> consolidate the files into one.
//
// Tuned rules (v1, config-tuned.json `tuned` keys), first rule that applies wins:
//   0. groupRows: rows of one parametrized or looped test (same `site`) are judged as one unit
//   1. not run (skipped or failed)                                    -> keep (no evidence)
//   2. brittle (strict detector)                                      -> rewrite
//   3. a same-file sibling with body shape similarity >= shapeSimilarity and own-line Jaccard >= lineJaccard
//      (same target and setup, different data); a critical unit only with a critical sibling -> consolidate
//   4. critical (D4 paths, plus extraCriticalPaths on test file names and criticalTags on titles) -> keep
//   5. unique lines or kills                                          -> keep (or slow-and-low-value rewrite)
//   6. spawns an interpreter                                          -> keep (coverage partial)
//   7. own is empty                                                   -> keep (no coverage evidence)
//   8. no unique line (after the per-process re-check): retire only when corroborated by a near-duplicate body
//      (shape similarity >= duplicateShape with a unit whose own lines contain this one's) or by mutation (in a
//      mutated area, no unique kill, at least one kill); otherwise keep, marked unverifiedRetire

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const stem = (file) => basename(file).replace(/\.test\.m?js$/, '').replace(/^test_/, '').replace(/\.py$/, '');

/** Shingles (k tokens) of a masked body, as a Set of strings. */
function shingles(shape, k = 4) {
  const t = (shape ?? '').split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k).join(' '));
  if (!out.size && t.length) out.add(t.join(' '));
  return out;
}
function jaccardSets(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Rows of one parametrized or looped test (same site) become one unit; mutation killers are remapped. */
export function groupRows(input) {
  const unitOf = new Map();
  const units = [];
  const map = new Int32Array(input.tests.length);
  input.tests.forEach((t, i) => {
    const key = t.site ? `${t.site}` : `id:${t.id}`;
    let u = unitOf.get(key);
    if (u === undefined) { unitOf.set(key, (u = units.length)); units.push([]); }
    units[u].push(i);
    map[i] = u;
  });
  const tests = units.map((idxs) => {
    const ts = idxs.map((i) => input.tests[i]);
    if (ts.length === 1) return { ...ts[0], rows: 1 };
    const lines = new Set(), recheck = new Set();
    let hasRecheck = true;
    for (const t of ts) { for (const l of t.lines) lines.add(l); if (t.recheckLines) for (const l of t.recheckLines) recheck.add(l); else hasRecheck = false; }
    const bad = ts.find((t) => !/^pass|^unknown$/.test(t.status ?? 'pass'));
    const base = ts[0].name.replace(/\[.*\]$/, '');
    return {
      ...ts[0], id: `${ts[0].site} (${ts.length} rows of ${base})`, rows: ts.length,
      name: base, ms: ts.reduce((a, t) => a + (t.ms ?? 0), 0), status: bad ? bad.status : ts[0].status,
      lines: [...lines], recheckLines: hasRecheck ? [...recheck] : undefined,
      spawned: ts.flatMap((t) => t.spawned ?? []), spawnsInterpreter: ts.some((t) => t.spawnsInterpreter),
    };
  });
  const mutation = input.mutation ? { ...input.mutation, mutants: input.mutation.mutants.map((m) => ({ ...m, killers: [...new Set(m.killers.map((i) => map[i]))] })) } : null;
  return { ...input, tests, mutation };
}

export function advise(input0, config) {
  const input = config.tuned?.groupRows ? groupRows(input0) : input0;
  const N = input.lineKeys.length;
  const critRe = new RegExp(config.critical.paths);
  const minorFileRe = config.minor?.testFiles ? new RegExp(config.minor.testFiles) : null;
  const minorKinds = new Set(config.minor?.brittleKinds ?? []);
  const brittleKinds = new Set(config.rewrite.brittleKinds);
  const tuned = config.tuned ?? {};

  // Source file of each line, and whether it is critical.
  const fileIdx = new Map();
  const files = [];
  const lineFile = new Int32Array(N);
  for (let l = 0; l < N; l++) {
    const k = input.lineKeys[l];
    const p = k.slice(0, k.lastIndexOf(':'));
    let f = fileIdx.get(p);
    if (f === undefined) { fileIdx.set(p, (f = files.length)); files.push(p); }
    lineFile[l] = f;
  }
  const critFile = files.map((p) => critRe.test(p));
  // config.scopeIgnore: sources left out of the counting scope (for example "^(?!src/)" for src/ only).
  const ignoreFile = config.scopeIgnore ? files.map((p) => new RegExp(config.scopeIgnore).test(p)) : files.map(() => false);
  const setup = new Uint8Array(N);
  for (const l of input.setupLines) setup[l] = 1;

  const T = input.tests.length;
  const own = input.tests.map((t) => Int32Array.from(new Set(t.lines.filter((l) => !setup[l] && !ignoreFile[lineFile[l]]))).sort());
  const count = new Uint32Array(N);
  for (const s of own) for (const l of s) count[l]++;

  // Mutation.
  const uniqueKills = new Uint32Array(T);
  const kills = new Uint32Array(T);
  const mutFiles = new Set(input.mutation?.files ?? []);
  if (input.mutation) {
    for (const m of input.mutation.mutants) {
      for (const i of m.killers) kills[i]++;
      if (m.killers.length === 1 && !m.unnamedKillFiles.length) uniqueKills[m.killers[0]]++;
    }
  }

  // Per test-file groups.
  const byFile = new Map();
  input.tests.forEach((t, i) => { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(i); });

  const mark = new Uint8Array(N);
  const results = [];
  const shapeOf = tuned.shapeSimilarity || tuned.duplicateShape ? input.tests.map((t) => shingles(t.shape)) : null;
  const extraCritRe = tuned.extraCriticalPaths ? new RegExp(tuned.extraCriticalPaths, 'i') : null;
  const tagRe = tuned.criticalTags ? new RegExp(tuned.criticalTags, 'i') : null;
  const rarest = (o) => { let best = -1, bc = Infinity; for (const l of o) if (count[l] < bc) { bc = count[l]; best = l; } return best; };
  const coverers = new Map(); // line -> [unit], built on first use (duplicate search)
  const coverersOf = (l) => {
    if (!coverers.size) own.forEach((s, j) => { for (const x of s) { let a = coverers.get(x); if (!a) coverers.set(x, (a = [])); a.push(j); } });
    return coverers.get(l) ?? [];
  };
  const fileCrit = (f) => config.critical.byTestFile && (critRe.test(stem(f)) || !!(extraCritRe && extraCritRe.test(stem(f))));
  const critOf = (j) => {
    const u = input.tests[j];
    if (fileCrit(u.file) || (tagRe && tagRe.test(u.name))) return true;
    if (config.critical.byCoveredSource === 'any') for (const l of own[j]) if (critFile[lineFile[l]]) return true;
    return false;
  };
  for (let i = 0; i < T; i++) {
    const t = input.tests[i];
    const o = own[i];
    let uniqueLines = 0;
    const uniqueByFile = new Map();
    let touchesCrit = false, touchesMut = false, uniqueInCrit = 0;
    for (const l of o) {
      const f = lineFile[l];
      if (critFile[f]) touchesCrit = true;
      if (mutFiles.has(files[f])) touchesMut = true;
      if (count[l] === 1) {
        uniqueLines++;
        uniqueByFile.set(files[f], (uniqueByFile.get(files[f]) ?? 0) + 1);
        if (critFile[f]) uniqueInCrit++;
      }
    }
    // Tier.
    const reasons = [];
    let tier = 'standard';
    const testFileCrit = fileCrit(t.file);
    const tagCrit = !!(tagRe && tagRe.test(t.name));
    const bySource = config.critical.byCoveredSource === 'any' ? touchesCrit : config.critical.byCoveredSource === 'unique' ? uniqueInCrit > 0 : false;
    const byKill = tuned.criticalByUniqueKill && uniqueKills[i] > 0;
    if (testFileCrit || bySource || tagCrit || byKill) {
      tier = 'critical';
      reasons.push(`critical: ${[testFileCrit && 'test file name', bySource && (config.critical.byCoveredSource === 'any' ? 'covers a critical source' : 'unique lines in a critical source'), tagCrit && 'title tag', byKill && 'unique kill'].filter(Boolean).join(', ')}`);
    }
    const brittle = (t.brittle ?? []).filter((b) => brittleKinds.has(b.kind));
    const kinds = [...new Set(brittle.map((b) => b.kind))];
    if (tier !== 'critical' && ((minorFileRe && minorFileRe.test(t.file)) || (kinds.length && kinds.every((k) => minorKinds.has(k))))) tier = 'minor';

    // Siblings: subset and nearest (same file).
    let subsetOf = null, subsetSize = Infinity, nearest = null, nearestJ = 0;
    if (o.length) {
      for (const l of o) mark[l] = 1;
      for (const j of byFile.get(t.file)) {
        if (j === i) continue;
        const s = own[j];
        let inter = 0;
        for (const l of s) if (mark[l]) inter++;
        const jac = inter / (o.length + s.length - inter);
        if (inter === o.length && s.length < subsetSize) { subsetOf = j; subsetSize = s.length; }
        if (jac > nearestJ || (jac === nearestJ && nearest !== null && j < nearest)) { nearestJ = jac; nearest = j; }
      }
      for (const l of o) mark[l] = 0;
    }
    const signals = {
      ownLines: o.length, uniqueLines, uniqueKills: uniqueKills[i], kills: kills[i],
      evidence: touchesMut ? 'mutation+coverage' : 'coverage-only',
      ms: t.ms, brittle: kinds, spawnsInterpreter: !!t.spawnsInterpreter,
      subsetOf: subsetOf === null ? null : input.tests[subsetOf].id,
      nearest: nearest === null ? null : input.tests[nearest].id, nearestJaccard: Math.round(nearestJ * 1000) / 1000,
      uniqueByFile: Object.fromEntries([...uniqueByFile].sort((a, b) => b[1] - a[1]).slice(0, 3)),
    };
    let advice;
    const keepCov = uniqueLines >= config.keep.uniqueLines;
    const keepKill = uniqueKills[i] >= config.keep.uniqueKills;
    const slow = t.ms >= config.rewrite.slowMs;
    const zeroValue = !keepCov && !keepKill;
    // v1: a shape-similar same-file sibling (same target and setup, different data).
    let shapeSib = null, shapeSim = 0;
    if (tuned.shapeSimilarity && o.length) {
      for (const j of byFile.get(t.file)) {
        if (j === i || !own[j].length) continue;
        const sim = jaccardSets(shapeOf[i], shapeOf[j]);
        if (sim < tuned.shapeSimilarity || sim < shapeSim) continue;
        const sj = new Set(own[j]);
        let inter = 0;
        for (const l of o) if (sj.has(l)) inter++;
        const lj = inter / (o.length + own[j].length - inter);
        if (lj >= (tuned.lineJaccard ?? 0) && (sim > shapeSim || (shapeSib !== null && j < shapeSib))) { shapeSib = j; shapeSim = sim; }
      }
      signals.shapeSibling = shapeSib === null ? null : input.tests[shapeSib].id;
      signals.shapeSimilarity = Math.round(shapeSim * 1000) / 1000;
    }
    if (t.rows > 1) signals.rows = t.rows;
    if (config.tuned) {
      const notRun = t.status && !/^pass|^unknown$/.test(t.status);
      if (notRun) { advice = 'keep'; reasons.push(`not run (${t.status}): no evidence`); }
      else if (kinds.length) {
        advice = 'rewrite';
        reasons.push(`brittle: ${brittle.map((b) => `${b.kind} (line ${b.line}: ${String(b.evidence).slice(0, 50)})`).join('; ')}`);
      } else if (shapeSib !== null && (tier !== 'critical' || critOf(shapeSib))) {
        advice = 'consolidate';
        reasons.push(`same shape as a sibling (body similarity ${signals.shapeSimilarity}): ${input.tests[shapeSib].name.slice(0, 80)}`);
      } else if (tier === 'critical') {
        advice = 'keep';
      } else if (keepCov || keepKill) {
        if (slow && uniqueLines < config.rewrite.lowValueUniqueLines && !keepKill) {
          advice = 'rewrite';
          reasons.push(`slow and low value: ${t.ms} ms for ${uniqueLines} unique line(s); move down a layer`);
        } else {
          advice = 'keep';
          if (keepCov) reasons.push(`${uniqueLines} unique line(s)`);
          if (keepKill) reasons.push(`${uniqueKills[i]} unique kill(s)`);
        }
      } else if (t.spawnsInterpreter) {
        advice = 'keep';
        reasons.push(`coverage partial: spawns ${[...new Set(t.spawned)].slice(0, 3).join(', ')}`);
      } else if (!o.length) {
        advice = 'keep';
        signals.unverifiedRetire = true;
        reasons.push('no coverage evidence: covers no line beyond setup (it checks files, config or constants)');
      } else {
        advice = 'retire';
        reasons.push(`no unique line (${o.length} lines, all covered by other tests)`);
      }
    } else if (kinds.length && !(tuned.brittleOnlyWhenNoUniqueBehaviour && keepKill)) {
      advice = 'rewrite';
      reasons.push(`brittle: ${brittle.map((b) => `${b.kind} (line ${b.line}: ${String(b.evidence).slice(0, 50)})`).join('; ')}`);
      if (zeroValue && tier !== 'critical') reasons.push('and no unique coverage or kill');
    } else if (tier === 'critical' && !(tuned.criticalConsolidateIntoCritical && zeroValue && subsetOf !== null && isCritical(subsetOf))) {
      advice = 'keep';
    } else if (keepCov || keepKill) {
      if (slow && uniqueLines < config.rewrite.lowValueUniqueLines && !keepKill) {
        advice = 'rewrite';
        reasons.push(`slow and low value: ${t.ms} ms for ${uniqueLines} unique line(s); move down a layer`);
      } else {
        advice = 'keep';
        if (keepCov) reasons.push(`${uniqueLines} unique line(s)`);
        if (keepKill) reasons.push(`${uniqueKills[i]} unique kill(s)`);
      }
    } else if (config.partialCoverage?.spawnsInterpreterNeverRetire && t.spawnsInterpreter) {
      advice = 'keep';
      reasons.push(`coverage partial: spawns ${[...new Set(t.spawned)].slice(0, 3).join(', ')}`);
    } else if (!o.length) {
      advice = 'retire';
      reasons.push('covers no line beyond module load and setup');
    } else if (config.consolidate.subsetOfSibling && subsetOf !== null) {
      advice = 'consolidate';
      reasons.push(`lines are a subset of a sibling's: ${input.tests[subsetOf].name.slice(0, 80)}`);
    } else if (nearestJ >= config.consolidate.jaccard) {
      advice = 'consolidate';
      reasons.push(`same target as a sibling (Jaccard ${signals.nearestJaccard}): ${input.tests[nearest].name.slice(0, 80)}`);
    } else {
      advice = 'retire';
      reasons.push(`no unique line (${o.length} lines, all covered by other tests)${input.mutation ? (touchesMut ? ', no unique kill' : '') : ''}`);
    }
    if (advice === 'retire' && t.recheckLines) {
      // Per-process re-check (D7): lines this test covers when run alone that no other test covers.
      let uniqueA = 0;
      const mine = new Set(own[i]);
      for (const l of new Set(t.recheckLines)) {
        if (setup[l] || ignoreFile[lineFile[l]]) continue;
        if (count[l] - (mine.has(l) ? 1 : 0) === 0) uniqueA++;
      }
      signals.recheckUniqueLines = uniqueA;
      if (uniqueA >= config.keep.uniqueLines) {
        advice = 'keep';
        reasons.length = 0;
        if (tier === 'critical') reasons.push('critical');
        reasons.push(`per-process re-check: ${uniqueA} unique line(s) when run alone`);
      } else reasons.push('per-process re-check: still no unique line');
    }
    if (advice === 'retire' && config.tuned) {
      // v1: retire only when corroborated.
      let dup = null;
      if (tuned.duplicateShape) {
        for (const j of coverersOf(rarest(o))) {
          if (j === i || own[j].length < o.length) continue;
          if (jaccardSets(shapeOf[i], shapeOf[j]) < tuned.duplicateShape) continue;
          const sj = new Set(own[j]);
          if (o.every((l) => sj.has(l))) { dup = j; break; }
        }
      }
      const mutOk = !!(input.mutation && touchesMut && uniqueKills[i] === 0 && kills[i] > 0);
      if (dup !== null) { reasons.push(`corroborated: near-duplicate body of ${input.tests[dup].id.slice(0, 100)}`); signals.duplicateOf = input.tests[dup].id; }
      else if (mutOk) reasons.push('corroborated: in a mutated area, every mutant it kills is killed by another test');
      else {
        advice = 'keep';
        signals.unverifiedRetire = true;
        reasons.push('unverified: no unique line, but coverage cannot show its assertions are redundant');
      }
    }
    if (advice === 'retire' && tuned.retireNeedsMutationEvidence && !touchesMut && input.mutation) {
      // (option, off by default) only advise retire where mutation evidence exists
      advice = 'keep';
      reasons.push('no mutation evidence for this area');
    }
    reasons.push(`evidence: ${signals.evidence}`);
    results.push({ id: t.id, file: t.file, name: t.name, tier, advice, reasons, signals });
  }
  function isCritical(j) { return results[j]?.tier === 'critical'; }

  // File groups: same primary target, names prefixes of one another.
  const groups = [];
  if (config.consolidate.fileGroups) {
    const filesOfLine = new Map(); // line -> number of test files covering it
    const fileLines = new Map();
    for (const [f, idxs] of byFile) {
      const set = new Set();
      for (const i of idxs) for (const l of own[i]) set.add(l);
      fileLines.set(f, set);
      for (const l of set) filesOfLine.set(l, (filesOfLine.get(l) ?? 0) + 1);
    }
    const target = new Map();
    for (const [f, set] of fileLines) {
      const score = new Map();
      for (const l of set) { const s = files[lineFile[l]]; score.set(s, (score.get(s) ?? 0) + 1 / filesOfLine.get(l)); }
      let best = null, bs = 0;
      for (const [s, v] of score) if (v > bs || (v === bs && best !== null && s < best)) { best = s; bs = v; }
      if (best) target.set(f, { source: best, score: bs });
    }
    const toks = (f) => stem(f).split(/[-_]/);
    const isPrefix = (a, b) => a.length < b.length && a.every((x, k) => x === b[k]);
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    const fl = [...target.keys()].sort();
    for (const f of fl) parent.set(f, f);
    for (let a = 0; a < fl.length; a++) {
      for (let b = a + 1; b < fl.length; b++) {
        const A = fl[a], B = fl[b];
        if (target.get(A).source !== target.get(B).source) continue;
        if (config.consolidate.fileGroupNamePrefix && !isPrefix(toks(A), toks(B)) && !isPrefix(toks(B), toks(A))) continue;
        parent.set(find(B), find(A));
      }
    }
    const g = new Map();
    for (const f of fl) { const r = find(f); if (!g.has(r)) g.set(r, []); g.get(r).push(f); }
    for (const members of g.values()) {
      if (members.length < 2) continue;
      const tests = members.flatMap((f) => byFile.get(f));
      const crit = tests.some((i) => results[i].tier === 'critical');
      groups.push({ kind: 'files', advice: 'consolidate', files: members, target: target.get(members[0]).source, tests: tests.length, critical: crit,
        ms: tests.reduce((a, i) => a + (input.tests[i].ms ?? 0), 0),
        reasons: [`${members.length} test files share the primary target ${target.get(members[0]).source}; their names extend one another`] });
    }
  }

  const counts = { tests: T };
  for (const r of results) { counts[r.advice] = (counts[r.advice] ?? 0) + 1; counts[`tier:${r.tier}`] = (counts[`tier:${r.tier}`] ?? 0) + 1; }
  counts.fileGroups = groups.length;
  counts.retireMs = results.filter((r) => r.advice === 'retire').reduce((a, r) => a + (r.signals.ms ?? 0), 0);
  counts.unverifiedRetire = results.filter((r) => r.signals.unverifiedRetire).length;
  return { spec: config.spec, suite: input.suite, counts, tests: results, groups };
}
