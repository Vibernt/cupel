#!/usr/bin/env node
// S2 analysis: compares method A (one process per test) with method B (in-process takes at test boundaries).
//
// Usage:
//   node plans/spikes/s2/analyze.mjs --root /abs/suite --out /abs/out-s2 [--report plans/spikes/s2/results]
// Reads <out>/a (run-a.mjs) and <out>/b (run-b.mjs). Prints markdown tables; writes summary.json and
// per-test.csv into --report (small files, meant to be committed).
//
// Definitions (the same for both methods; lines follow the rule in lines.mjs, keys are 'path:line'):
//  M(T)      lines covered by test T. A: the whole per-test process (module load included).
//            B: the deltas owned by T (its own segments; shared concurrent segments go to every owner).
//  S_M(F)    setup lines of file F. A: the run whose name pattern matches no test (module load).
//            B: every segment of F's process that no test owned (setup, between tests, teardown).
//  U_M(T)    unique lines: M(T) minus M(T') for every other test T' of all three files, minus S_M(F) of
//            every file. "Would this line lose its coverage if T were deleted?"
//  Jaccard   |X ∩ Y| / |X ∪ Y|, 1 when both are empty.
//            raw:  A(T) vs S_B,setup(F) ∪ B(T)            (what a test touches when it runs, setup included)
//            test: A(T) − S(F) vs B(T) − S(F), S(F) = S_A(F) ∪ S_B(F)   (the test's own part only)

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { args, median } from './exec.mjs';
import { LineRule } from './lines.mjs';

const opt = args(process.argv.slice(2), { rep: '1' });
if (!opt.root || !opt.out) {
  console.error('usage: node analyze.mjs --root <suite> --out <dir> [--report <dir>]');
  process.exit(2);
}
const rule = new LineRule(opt.root);
const lists = JSON.parse(readFileSync(join(opt.out, 'a', 'lists.json'), 'utf8'));
const files = Object.keys(lists);
const aTimings = JSON.parse(readFileSync(join(opt.out, 'a', 'timings.json'), 'utf8'));
const bTimings = JSON.parse(readFileSync(join(opt.out, 'b', 'timings.json'), 'utf8'));
const reps = [...new Set(aTimings.filter((r) => r.rep > 0).map((r) => r.rep))].sort();

const union = (...sets) => { const o = new Set(); for (const s of sets) for (const x of s) o.add(x); return o; };
const minus = (a, ...bs) => { const o = new Set(); for (const x of a) if (!bs.some((b) => b.has(x))) o.add(x); return o; };
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const jaccard = (a, b) => { const i = inter(a, b); const u = a.size + b.size - i; return u ? i / u : 1; };
const keysOf = (obj) => { const o = new Set(); for (const [p, ls] of Object.entries(obj)) for (const l of ls) o.add(`${p}:${l}`); return o; };
const mapKeys = (map) => { const o = new Set(); for (const [p, ls] of map) for (const l of ls) o.add(`${p}:${l}`); return o; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-');

// ---------- load A ----------
function loadA(rep) {
  const tests = new Map(); const setup = new Map(); const procs = new Map();
  for (const file of files) {
    const base = join(opt.out, 'a', `r${rep}`, basename(file));
    setup.set(file, keysOf(JSON.parse(readFileSync(join(base, 'setup', 'lines.json'), 'utf8')).lines));
    lists[file].forEach((name, i) => {
      const d = JSON.parse(readFileSync(join(base, String(i).padStart(3, '0'), 'lines.json'), 'utf8'));
      tests.set(`${file}::${name}`, keysOf(d.lines));
      procs.set(`${file}::${name}`, d.processes);
    });
  }
  return { tests, setup, procs };
}

// ---------- load B ----------
function loadB(rep) {
  const tests = new Map(); const setupLoad = new Map(); const setupAll = new Map(); const meta = new Map();
  const processMs = new Map(); const sharedSegments = []; const betweenLines = new Map();
  for (const file of files) {
    const dir = join(opt.out, 'b', 'coverage', `r${rep}`, basename(file));
    const f = readdirSync(dir).find((x) => x.startsWith('b-') && x.endsWith('.json') && !x.endsWith('.write.json'));
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const t0 = process.hrtime.bigint();
    const own = new Map(); const sLoad = new Set(); const sAll = new Set(); const between = new Set();
    for (const s of d.segments) {
      const lines = s.lines ? keysOf(s.lines) : mapKeys(rule.lineSets(s.scripts));
      if (s.kind === 'test') {
        for (const o of s.owners) { if (!own.has(o)) own.set(o, new Set()); for (const l of lines) own.get(o).add(l); }
        if (s.shared) sharedSegments.push({ file, owners: s.owners, lines: lines.size });
      } else {
        for (const l of lines) sAll.add(l);
        if (s.kind === 'setup') for (const l of lines) sLoad.add(l);
        if (s.kind === 'between') for (const l of lines) between.add(l);
      }
    }
    processMs.set(file, Number(process.hrtime.bigint() - t0) / 1e6);
    for (const t of d.tests) {
      // Roll nested tests up to their top-level test (the unit --test-name-pattern can select).
      const top = t.name.split(' > ')[0];
      const key = `${file}::${top}`;
      if (!tests.has(key)) tests.set(key, new Set());
      for (const l of own.get(t.key) ?? []) tests.get(key).add(l);
      const m = meta.get(key) ?? { spawned: [], nested: 0 };
      m.spawned.push(...t.spawned); if (t.depth > 0) m.nested++;
      meta.set(key, m);
    }
    setupLoad.set(file, sLoad); setupAll.set(file, sAll); betweenLines.set(file, between);
  }
  return { tests, setupLoad, setupAll, meta, processMs, sharedSegments, betweenLines };
}

function uniques(tests, setups) {
  const count = new Map();
  for (const s of tests.values()) for (const l of s) count.set(l, (count.get(l) ?? 0) + 1);
  const allSetup = union(...setups.values());
  const out = new Map();
  for (const [k, s] of tests) { const u = new Set(); for (const l of s) if (count.get(l) === 1 && !allSetup.has(l)) u.add(l); out.set(k, u); }
  return out;
}

const A = loadA(Number(opt.rep));
const B = loadB(Number(opt.rep));
const UA = uniques(A.tests, A.setup);
const UB = uniques(B.tests, B.setupAll);

// ---------- per test ----------
const rows = [];
for (const file of files) {
  const S = union(A.setup.get(file), B.setupAll.get(file));
  for (const name of lists[file]) {
    const k = `${file}::${name}`;
    const a = A.tests.get(k) ?? new Set(); const b = B.tests.get(k) ?? new Set();
    const bAlone = union(B.setupLoad.get(file), b);
    const meta = B.meta.get(k) ?? { spawned: [], nested: 0 };
    rows.push({
      file: basename(file), test: name,
      linesA: a.size, linesB: b.size, linesBAlone: bAlone.size,
      jaccardRaw: jaccard(a, bAlone), jaccardTest: jaccard(minus(a, S), minus(b, S)),
      uniqueA: UA.get(k)?.size ?? 0, uniqueB: UB.get(k)?.size ?? 0,
      uniqueJaccard: jaccard(UA.get(k) ?? new Set(), UB.get(k) ?? new Set()),
      uniqueBnotA: minus(UB.get(k) ?? new Set(), UA.get(k) ?? new Set()).size,
      uniqueAnotB: minus(UA.get(k) ?? new Set(), UB.get(k) ?? new Set()).size,
      bNotA: minus(b, a).size, aNotB: minus(a, bAlone, B.setupAll.get(file)).size,
      spawned: meta.spawned.length, spawnedWhat: [...new Set(meta.spawned)].join(' '),
      aProcesses: A.procs.get(k)?.length ?? 0, nested: meta.nested,
    });
  }
}

// ---------- per file ----------
const fileSetA = new Map(); const fileSetB = new Map();
for (const file of files) {
  fileSetA.set(file, union(A.setup.get(file), ...lists[file].map((n) => A.tests.get(`${file}::${n}`) ?? new Set())));
  fileSetB.set(file, union(B.setupAll.get(file), ...lists[file].map((n) => B.tests.get(`${file}::${n}`) ?? new Set())));
}
const fileUnique = (sets, file) => minus(sets.get(file), ...files.filter((f) => f !== file).map((f) => sets.get(f)));

// ---------- stability across repeats ----------
const stability = { A: [], B: [] };
for (const rep of reps.filter((r) => r !== Number(opt.rep))) {
  let a2, b2;
  try { a2 = loadA(rep); } catch { a2 = null; }
  try { b2 = loadB(rep); } catch { b2 = null; }
  for (const [k, s] of A.tests) if (a2) stability.A.push(jaccard(s, a2.tests.get(k) ?? new Set()));
  for (const [k, s] of B.tests) if (b2) stability.B.push(jaccard(s, b2.tests.get(k) ?? new Set()));
}

// ---------- costs ----------
const bRow = (file, v, rep) => bTimings.find((r) => r.file === file && r.variant === v && r.rep === rep);
const cost = files.map((file) => {
  const n = lists[file].length;
  const per = (v, key) => reps.map((rep) => bRow(file, v, rep)?.[key]);
  const aTotal = (key, withSetup) => reps.map((rep) => aTimings.filter((r) => r.rep === rep && r.file === file && (withSetup || r.kind === 'test')).reduce((s, r) => s + r[key], 0));
  const aPerTest = aTimings.filter((r) => r.rep > 0 && r.file === file && r.kind === 'test');
  const takes = per('coverage', 'takes'); const takeMs = per('coverage', 'takeMsTotal');
  return {
    file: basename(file), tests: n,
    plainWall: per('plain', 'wallMs'), plainCpu: per('plain', 'cpuMs'),
    directWall: per('direct', 'wallMs'), directCpu: per('direct', 'cpuMs'),
    hooksWall: per('hooks', 'wallMs'), hooksCpu: per('hooks', 'cpuMs'),
    startWall: per('start-only', 'wallMs'), startCpu: per('start-only', 'cpuMs'),
    bWall: per('coverage', 'wallMs'), bCpu: per('coverage', 'cpuMs'),
    bTakes: median(takes), bTakeMsPer: median(takeMs.map((t, i) => t / takes[i])), bTakeMsTotal: median(takeMs),
    bWriteMs: median(per('coverage', 'writeMs')), bRawBytes: median(per('coverage', 'rawBytes')),
    aWall: aTotal('wallMs', false), aCpu: aTotal('cpuMs', false),
    aWallWithSetup: aTotal('wallMs', true), aCpuWithSetup: aTotal('cpuMs', true),
    aProcessMs: aTotal('processMs', true),
    aPerTestWallMedian: median(aPerTest.map((r) => r.wallMs)), aPerTestWallMin: Math.min(...aPerTest.map((r) => r.wallMs)),
    aPerTestWallMax: Math.max(...aPerTest.map((r) => r.wallMs)), aPerTestCpuMedian: median(aPerTest.map((r) => r.cpuMs)),
    aSetupWall: median(aTimings.filter((r) => r.rep > 0 && r.file === file && r.kind === 'setup').map((r) => r.wallMs)),
    aChecks: aTimings.filter((r) => r.rep > 0 && r.file === file && (r.kind === 'test' ? r.ran !== 1 || r.pass !== 1 : r.ran !== 0)).length,
    bFails: reps.map((rep) => bRow(file, 'coverage', rep)?.fail ?? 0).reduce((a, b) => a + b, 0),
  };
});

// ---------- print ----------
const out = [];
const p = (s = '') => out.push(s);
const spread = (xs) => `${f0(median(xs))} (${f0(Math.min(...xs))}–${f0(Math.max(...xs))})`;
p('## Cost per file (median of repeats, min–max in brackets; ms)');
p();
p('| File | Tests | Plain `node --test` wall | Plain CPU | B wall | B CPU | B / plain (wall) | A wall (sum of per-test runs) | A CPU | A / plain (wall) |');
p('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const c of cost) {
  p(`| ${c.file} | ${c.tests} | ${spread(c.plainWall)} | ${spread(c.plainCpu)} | ${spread(c.bWall)} | ${spread(c.bCpu)} | ${f2(median(c.bWall) / median(c.plainWall))}× | ${spread(c.aWall)} | ${spread(c.aCpu)} | ${f1(median(c.aWall) / median(c.plainWall))}× |`);
}
const tot = (key) => median(reps.map((_, i) => cost.reduce((s, c) => s + c[key][i], 0)));
const nTests = cost.reduce((s, c) => s + c.tests, 0);
p(`| **all three** | ${nTests} | ${f0(tot('plainWall'))} | ${f0(tot('plainCpu'))} | ${f0(tot('bWall'))} | ${f0(tot('bCpu'))} | ${f2(tot('bWall') / tot('plainWall'))}× | ${f0(tot('aWall'))} | ${f0(tot('aCpu'))} | ${f1(tot('aWall') / tot('plainWall'))}× |`);
p();
p('## Cost per test (ms)');
p();
p('| File | A: per-test process wall, median (min–max) | A: per-test CPU, median | A: coverage → lines, per test | B: extra wall per test vs plain | B: extra CPU per test | B: one take | B: takes per test | B: ranges → lines, per test |');
p('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
const bProc = B.processMs;
for (const c of cost) {
  const file = files.find((f) => basename(f) === c.file);
  p(`| ${c.file} | ${f0(c.aPerTestWallMedian)} (${f0(c.aPerTestWallMin)}–${f0(c.aPerTestWallMax)}) | ${f0(c.aPerTestCpuMedian)} | ${f1(median(c.aProcessMs) / (c.tests + 1))} | ${f1((median(c.bWall) - median(c.plainWall)) / c.tests)} | ${f1((median(c.bCpu) - median(c.plainCpu)) / c.tests)} | ${f2(c.bTakeMsPer)} | ${f1(c.bTakes / c.tests)} | ${f1(bProc.get(file) / c.tests)} |`);
}
p();
p('## Where B\'s overhead comes from (wall ms, median of repeats)');
p();
p('| File | direct `node file` | plain `node --test` | + hooks only | + precise coverage on, no takes | + takes (method B) | sum of take times | raw output written |');
p('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const c of cost) {
  p(`| ${c.file} | ${f0(median(c.directWall))} | ${f0(median(c.plainWall))} | ${f0(median(c.hooksWall))} | ${f0(median(c.startWall))} | ${f0(median(c.bWall))} | ${f0(c.bTakeMsTotal)} | ${(c.bRawBytes / 1e6).toFixed(1)} MB in ${f0(c.bWriteMs)} ms |`);
}
p();
p('## Agreement and unique lines per file');
p();
p('| File | Tests | Jaccard raw, mean (min) | Jaccard test-only, mean (min) | Tests with test-only Jaccard ≥ 0.95 | Unique lines A | Unique lines B | Zero-unique tests A | Zero-unique tests B | Same zero/non-zero verdict | File-level unique lines A | File-level unique lines B |');
p('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
const fileRows = [];
for (const file of files) {
  const rs = rows.filter((r) => r.file === basename(file));
  const fr = {
    file: basename(file), tests: rs.length,
    jRaw: mean(rs.map((r) => r.jaccardRaw)), jRawMin: Math.min(...rs.map((r) => r.jaccardRaw)),
    jTest: mean(rs.map((r) => r.jaccardTest)), jTestMin: Math.min(...rs.map((r) => r.jaccardTest)),
    jTest95: rs.filter((r) => r.jaccardTest >= 0.95).length,
    uA: rs.reduce((s, r) => s + r.uniqueA, 0), uB: rs.reduce((s, r) => s + r.uniqueB, 0),
    zA: rs.filter((r) => r.uniqueA === 0).length, zB: rs.filter((r) => r.uniqueB === 0).length,
    sameVerdict: rs.filter((r) => (r.uniqueA === 0) === (r.uniqueB === 0)).length,
    fileUA: fileUnique(fileSetA, file).size, fileUB: fileUnique(fileSetB, file).size,
    fileUAtests: minus(fileUnique(fileSetA, file), A.setup.get(file)).size,
    fileUAsingle: rs.reduce((s, r) => s + r.uniqueA, 0),
    fileLinesA: fileSetA.get(file).size, fileLinesB: fileSetB.get(file).size,
    setupA: A.setup.get(file).size, setupB: B.setupAll.get(file).size, setupBLoad: B.setupLoad.get(file).size,
    betweenB: B.betweenLines.get(file).size,
  };
  fileRows.push(fr);
  p(`| ${fr.file} | ${fr.tests} | ${f2(fr.jRaw)} (${f2(fr.jRawMin)}) | ${f2(fr.jTest)} (${f2(fr.jTestMin)}) | ${fr.jTest95} | ${fr.uA} | ${fr.uB} | ${fr.zA} | ${fr.zB} | ${fr.sameVerdict}/${fr.tests} | ${fr.fileUA} | ${fr.fileUB} |`);
}
const all = (k) => fileRows.reduce((s, r) => s + r[k], 0);
p(`| **all three** | ${rows.length} | ${f2(mean(rows.map((r) => r.jaccardRaw)))} | ${f2(mean(rows.map((r) => r.jaccardTest)))} | ${all('jTest95')} | ${all('uA')} | ${all('uB')} | ${all('zA')} | ${all('zB')} | ${all('sameVerdict')}/${rows.length} | ${all('fileUA')} | ${all('fileUB')} |`);
p();
p('## Per-file versus per-test unique lines (method A; uniqueness across the three files)');
p();
p('| File | Tests | Lines unique to the file | of which not module-load lines | of which covered by exactly one test | Share pinned to one test | Tests with zero unique lines |');
p('|---|---:|---:|---:|---:|---:|---:|');
for (const fr of fileRows) p(`| ${fr.file} | ${fr.tests} | ${fr.fileUA} | ${fr.fileUAtests} | ${fr.fileUAsingle} | ${pct(fr.fileUAsingle / fr.fileUAtests)} | ${fr.zA} |`);
p();
p('## Lines per file process (covered src/** and public/** lines)');
p();
p('| File | All lines, A (union of runs) | All lines, B (one process) | Setup A (module load) | Setup B (all non-test segments) | of which before the first test | of which between tests |');
p('|---|---:|---:|---:|---:|---:|---:|');
for (const fr of fileRows) p(`| ${fr.file} | ${fr.fileLinesA} | ${fr.fileLinesB} | ${fr.setupA} | ${fr.setupB} | ${fr.setupBLoad} | ${fr.betweenB} |`);
p();
p('## Disagreements');
p();
const dis = rows.filter((r) => r.bNotA > 0 || r.aNotB > 0);
p(`Tests where B gives the test lines that A's run of that test does not cover: ${rows.filter((r) => r.bNotA > 0).length} (lines: ${rows.reduce((s, r) => s + r.bNotA, 0)}).`);
p(`Tests where A covers lines that B gives to no part of the test or its file's setup: ${rows.filter((r) => r.aNotB > 0).length} (lines: ${rows.reduce((s, r) => s + r.aNotB, 0)}).`);
p(`Tests whose unique-line sets differ between A and B: ${rows.filter((r) => r.uniqueJaccard < 1).length}. ` +
  `Lines unique in B but not in A: ${rows.reduce((s, r) => s + r.uniqueBnotA, 0)} (in ${rows.filter((r) => r.uniqueBnotA).length} tests); ` +
  `unique in A but not in B: ${rows.reduce((s, r) => s + r.uniqueAnotB, 0)} (in ${rows.filter((r) => r.uniqueAnotB).length} tests).`);
for (const r of rows.filter((x) => x.uniqueBnotA || x.uniqueAnotB)) p(`- ${r.file} :: ${r.test.slice(0, 90)}: unique A ${r.uniqueA}, unique B ${r.uniqueB} (B only ${r.uniqueBnotA}, A only ${r.uniqueAnotB})`);
p();
p('| Test | File | A lines | B lines | Jaccard test-only | B not A | A not B | Unique A | Unique B |');
p('|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of [...dis].sort((x, y) => x.jaccardTest - y.jaccardTest).slice(0, 12)) {
  p(`| ${r.test.slice(0, 70)}${r.test.length > 70 ? '…' : ''} | ${r.file} | ${r.linesA} | ${r.linesB} | ${f2(r.jaccardTest)} | ${r.bNotA} | ${r.aNotB} | ${r.uniqueA} | ${r.uniqueB} |`);
}
p();
p('## Child processes, nesting, concurrency');
p();
const spawners = rows.filter((r) => r.spawned > 0);
p(`Tests that start a child process or worker (B cannot see their coverage): ${spawners.length} of ${rows.length}` +
  `${spawners.length ? ` (${spawners.map((r) => `${r.file}: ${r.spawned}× ${r.spawnedWhat}`).join('; ')})` : ''}.`);
p(`A runs with more than one coverage file (a child node process wrote coverage): ${rows.filter((r) => r.aProcesses > 1).length}.`);
p(`Nested subtests seen: ${rows.reduce((s, r) => s + r.nested, 0)}. Shared (concurrent) segments: ${B.sharedSegments.length}.`);
p();
p('## Stability across repeats (Jaccard of a test\'s lines, repeat 1 vs the others)');
p();
p(`A: mean ${f2(mean(stability.A))}, min ${f2(Math.min(...stability.A))}, below 1: ${stability.A.filter((x) => x < 1).length} of ${stability.A.length}.`);
p(`B: mean ${f2(mean(stability.B))}, min ${f2(Math.min(...stability.B))}, below 1: ${stability.B.filter((x) => x < 1).length} of ${stability.B.length}.`);
p();
p(`Correctness checks: A runs that did not run exactly one passing test (or, for setup, ran a test): ${cost.reduce((s, c) => s + c.aChecks, 0)}. B coverage runs with failures: ${cost.reduce((s, c) => s + c.bFails, 0)}.`);
console.log(out.join('\n'));

if (opt.report) {
  mkdirSync(opt.report, { recursive: true });
  writeFileSync(join(opt.report, 'summary.json'), `${JSON.stringify({ reps, cost, files: fileRows, sharedSegments: B.sharedSegments.length,
    stability: { A: { mean: mean(stability.A), min: Math.min(...stability.A) }, B: { mean: mean(stability.B), min: Math.min(...stability.B) } } }, null, 1)}\n`);
  const cols = ['file', 'test', 'linesA', 'linesB', 'linesBAlone', 'jaccardRaw', 'jaccardTest', 'uniqueA', 'uniqueB', 'uniqueJaccard', 'bNotA', 'aNotB', 'spawned', 'aProcesses', 'nested'];
  const esc = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : `"${String(v).replace(/"/g, '""')}"`);
  writeFileSync(join(opt.report, 'per-test.csv'), `${cols.join(',')}\n${rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n')}\n`);
  writeFileSync(join(opt.report, 'tables.md'), `${out.join('\n')}\n`);
}
