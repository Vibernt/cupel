#!/usr/bin/env node
// S2 generalisation check: method B over a whole node:test suite, the normal way (`node --test`, one process per
// file, files in parallel), against a plain run of the same suite.
//
// Usage:
//   node plans/spikes/s2/run-suite.mjs --root /abs/suite --out /abs/out-s2 [--reps 2] [--glob-dir tests] [--suffix .test.mjs]
//   node plans/spikes/s2/run-suite.mjs --root /abs/suite --out /abs/out-s2 --analyze-only
//
// Runs, per repeat: plain `node --test <files>` and `node --test --import hook.mjs <files>` with
// CUPEL_S2_FORMAT=lines (each file's process turns its own deltas into covered lines before it exits).
// Then, from the last coverage repeat: tests seen, tests that spawn processes, nested and concurrent tests,
// and unique lines per test across the whole suite versus unique lines per file.
// Writes <out>/suite/<variant>/r<rep>/ and <out>/suite/summary.json; prints a summary.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timed, args, readNdjson, median } from './exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { reps: '2', 'glob-dir': 'tests', suffix: '.test.mjs' });
if (!opt.root || !opt.out) {
  console.error('usage: node run-suite.mjs --root <suite> --out <dir> [--reps 2] [--analyze-only]');
  process.exit(2);
}
const files = readdirSync(join(opt.root, opt['glob-dir'])).filter((f) => f.endsWith(opt.suffix)).sort().map((f) => `${opt['glob-dir']}/${f}`);
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_V8_COVERAGE;
delete env.NODE_OPTIONS;
const base = join(opt.out, 'suite');
const summaryPath = join(base, 'runs.json');
const runs = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : [];

if (!opt['analyze-only']) {
  for (let rep = 1; rep <= Number(opt.reps); rep++) {
    for (const v of ['plain', 'coverage']) {
      const dir = join(base, v, `r${rep}`);
      mkdirSync(dir, { recursive: true });
      const argv = [process.execPath, '--test', `--test-reporter=${join(HERE, 'reporter.mjs')}`, `--test-reporter-destination=${join(dir, 'tests.ndjson')}`];
      const e = { ...env };
      if (v === 'coverage') {
        argv.push('--import', join(HERE, 'hook.mjs'));
        Object.assign(e, { CUPEL_S2_OUT: dir, CUPEL_S2_ROOT: opt.root, CUPEL_S2_FORMAT: 'lines' });
      }
      const r = timed([...argv, ...files], { cwd: opt.root, env: e, log: join(dir, 'log.txt') });
      const res = readNdjson(join(dir, 'tests.ndjson')).filter((x) => x.type !== 'suite');
      const row = { rep, variant: v, ...r, files: files.length, tests: res.length, pass: res.filter((x) => x.event === 'pass').length, fail: res.filter((x) => x.event === 'fail').length,
        failed: res.filter((x) => x.event === 'fail').map((x) => `${x.file?.split('/').pop()} :: ${x.name}`) };
      runs.push(row);
      console.log(`r${rep} ${v.padEnd(8)} wall ${(r.wallMs / 1000).toFixed(1)} s cpu ${(r.cpuMs / 1000).toFixed(1)} s tests ${row.pass}/${row.tests} fail ${row.fail}`);
      writeFileSync(summaryPath, JSON.stringify(runs, null, 1));
    }
  }
}

// ---------- analysis of the last coverage repeat ----------
const lastRep = Math.max(...runs.filter((r) => r.variant === 'coverage').map((r) => r.rep));
const dir = join(base, 'coverage', `r${lastRep}`);
const ids = new Map(); // 'path:line' -> int
const idOf = (k) => { let i = ids.get(k); if (i === undefined) ids.set(k, (i = ids.size)); return i; };
const perTest = []; // { file, name, lines: Int32Array }
const perFile = new Map(); // file -> Set<int>
const setup = new Set();
let takes = 0, takeMs = 0, processMs = 0, bytes = 0, shared = 0, sharedFiles = new Set(), between = 0, spawnTests = 0, spawnFiles = new Set(), nested = 0, processes = 0;
const spawnKinds = new Map();
for (const f of readdirSync(dir).filter((x) => x.startsWith('b-') && x.endsWith('.json') && !x.endsWith('.write.json'))) {
  const text = readFileSync(join(dir, f), 'utf8');
  bytes += text.length;
  const d = JSON.parse(text);
  processes++;
  takes += d.takes; takeMs += d.takeMsTotal; processMs += d.processMs ?? 0;
  const own = new Map();
  const fileSet = new Set();
  for (const s of d.segments) {
    const lines = [];
    for (const [p, ls] of Object.entries(s.lines ?? {})) for (const l of ls) lines.push(idOf(`${p}:${l}`));
    for (const l of lines) fileSet.add(l);
    if (s.kind === 'test') {
      if (s.shared) { shared++; sharedFiles.add(d.file); }
      for (const o of s.owners) { if (!own.has(o)) own.set(o, new Set()); for (const l of lines) own.get(o).add(l); }
    } else {
      for (const l of lines) setup.add(l);
      if (s.kind === 'between' && lines.length) between++;
    }
  }
  perFile.set(d.file, fileSet);
  let fileSpawns = false;
  for (const t of d.tests) {
    if (t.depth > 0) nested++;
    if (t.spawned.length) { spawnTests++; fileSpawns = true; for (const s of t.spawned) spawnKinds.set(s, (spawnKinds.get(s) ?? 0) + 1); }
    perTest.push({ file: d.file, name: t.key, depth: t.depth, lines: Int32Array.from(own.get(t.key) ?? []) });
  }
  if (fileSpawns) spawnFiles.add(d.file);
}
// Unique lines per test across the whole suite, two ways: leaf tests with their own segments (a parent keeps only
// the code it runs outside its subtests), and top-level tests with their whole subtree rolled up.
const isLeaf = (t) => !perTest.some((u) => u !== t && u.file === t.file && u.name.startsWith(`${t.name} > `));
const tops = new Map();
for (const t of perTest) {
  const k = `${t.file}::${t.name.split(' > ')[0]}`;
  if (!tops.has(k)) tops.set(k, new Set());
  for (const l of t.lines) tops.get(k).add(l);
}
function uniqueCounts(sets) {
  const count = new Uint32Array(ids.size);
  for (const s of sets) for (const l of s) count[l]++;
  return sets.map((s) => { let u = 0; for (const l of s) if (count[l] === 1 && !setup.has(l)) u++; return u; });
}
const leafSets = perTest.map((t) => t.lines);
const leafU = uniqueCounts(leafSets);
const leafIdx = perTest.map((t, i) => (isLeaf(t) ? i : -1)).filter((i) => i >= 0);
const topU = uniqueCounts([...tops.values()]);
const uniqueLeaf = leafU.reduce((a, b) => a + b, 0);
const zeroLeaf = leafIdx.filter((i) => leafU[i] === 0).length;
// Unique per file across the suite.
const fileCount = new Uint32Array(ids.size);
for (const s of perFile.values()) for (const l of s) fileCount[l]++;
let zeroFiles = 0, uniqueFileLines = 0;
for (const s of perFile.values()) { let u = 0; for (const l of s) if (fileCount[l] === 1) u++; uniqueFileLines += u; if (!u) zeroFiles++; }
const summary = {
  files: files.length, processes, testsSeen: perTest.length, leafTests: leafIdx.length, topLevelTests: tops.size, nestedTests: nested,
  coveredLines: ids.size, setupLines: setup.size,
  takes, takeMsTotal: takeMs, processMsTotal: processMs, outputMB: bytes / 1e6,
  sharedSegments: shared, filesWithSharedSegments: sharedFiles.size, betweenSegmentsWithLines: between,
  testsThatSpawn: spawnTests, filesThatSpawn: spawnFiles.size, spawnKinds: Object.fromEntries([...spawnKinds].sort((a, b) => b[1] - a[1]).slice(0, 15)),
  perLeafTest: { uniqueLines: uniqueLeaf, zeroUniqueLeaves: zeroLeaf },
  perTopLevelTest: { uniqueLines: topU.reduce((a, b) => a + b, 0), zeroUniqueTests: topU.filter((u) => u === 0).length },
  perFile: { uniqueLines: uniqueFileLines, zeroUniqueFiles: zeroFiles },
  runs: ['plain', 'coverage'].map((v) => {
    const rs = runs.filter((r) => r.variant === v);
    return { variant: v, reps: rs.length, wallMs: rs.map((r) => r.wallMs), cpuMs: rs.map((r) => r.cpuMs), medianWallMs: median(rs.map((r) => r.wallMs)), medianCpuMs: median(rs.map((r) => r.cpuMs)), pass: rs.map((r) => r.pass), fail: rs.map((r) => r.fail), failed: [...new Set(rs.flatMap((r) => r.failed))] };
  }),
};
writeFileSync(join(base, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
