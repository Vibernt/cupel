#!/usr/bin/env node
// S4: gather the before/after numbers from the raw outputs into one small summary (plans/spikes/s4/summary.json).
//
// Usage:
//   node plans/spikes/s4/report.mjs --out /abs/out-s4 --write plans/spikes/s4/summary.json [--timing timing.json,timing-final.json]
//
// Reads, from --out: compare-before-r1-after-r1.json (compare.mjs), kills-area.json, kills-suite.json, killsx-area.json,
// killsx-suite.json (kills.mjs --json), timing*.json (timing.mjs), pins-before.json and pins-after.json (pins.mjs),
// similar.json (similar.mjs). Missing inputs are left out. Prints the Markdown rows used in S4.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2), { timing: 'timing.json' });
const read = (name) => (existsSync(join(opt.out, name)) ? JSON.parse(readFileSync(join(opt.out, name), 'utf8')) : null);
const cmp = read('compare-before-r1-after-r1.json');
// Timing: the rows of every listed timing.mjs output, pooled; medians with min–max per side and variant.
const timingRuns = String(opt.timing).split(",").map(read).filter(Boolean);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const timing = timingRuns.length ? (() => {
  const rows = timingRuns.flatMap((t, i) => t.rows.map((r) => ({ ...r, session: i + 1 })));
  const summary = {};
  for (const key of new Set(rows.map((r) => `${r.set}/${r.variant}`))) {
    const rs = rows.filter((r) => `${r.set}/${r.variant}` === key);
    const stat = (k) => ({ median: Math.round(median(rs.map((r) => r[k]))), min: Math.round(Math.min(...rs.map((r) => r[k]))), max: Math.round(Math.max(...rs.map((r) => r[k]))) });
    summary[key] = { reps: rs.length, tests: rs[0].tests, wallMs: stat("wallMs"), cpuMs: stat("cpuMs"), load1: stat("load1") };
  }
  return { node: timingRuns[0].node, sessions: timingRuns.length, reps: rows.length / Object.keys(summary).length, summary };
})() : null;
const kills = Object.fromEntries(['kills-area', 'kills-suite', 'killsx-area', 'killsx-suite'].map((k) => [k, read(`${k}.json`)]).filter(([, v]) => v));
const pins = { before: read('pins-before.json')?.total, after: read('pins-after.json')?.total };
const similar = read('similar.json');

const strip = ({ perTest, ...rest }) => rest;
const summary = {
  coverage: cmp && { guardrail: cmp.guardrail, lost: cmp.lost.length, notEveryAfter: cmp.notEveryAfter?.length, gained: cmp.gained, gainedByFile: cmp.gainedByFile, sets: Object.fromEntries(Object.entries(cmp.sets).map(([k, v]) => [k, strip(v)])) },
  timing,
  mutation: Object.fromEntries(Object.entries(kills).map(([k, v]) => [k, {
    sameMutants: v.sameMutants, lost: v.lost?.length, gained: v.gained?.map((g) => g.id),
    before: { seed: v.before.seed, ids: v.before.idsHash, modules: v.before.modules, total: v.before.total },
    after: v.after && { modules: v.after.modules, total: v.after.total },
  }])),
  pins,
  similar: similar && { threshold: similar.threshold, groups: similar.groups.map((g) => g.map((x) => x.replace(/^tests\//, ''))) },
};
if (opt.write) writeFileSync(opt.write, `${JSON.stringify(summary, null, 1)}\n`);

const row = (label, b, a) => console.log(`| ${label} | ${b} | ${a} |`);
if (cmp) {
  const [B, A] = Object.values(cmp.sets);
  row('Test files', B.files, A.files);
  row('Tests', B.tests, A.tests);
  row('Test-file lines', B.fileLines, A.fileLines);
  row('Covered lines (union of 3 repeats)', B.ever, A.ever);
  row('Covered lines in every repeat', B.always, A.always);
  row('Covered lines outside module load', B.testDriven, A.testDriven);
  row('Lines unique to one test (within the area)', B.uniqueLines, A.uniqueLines);
  row('Tests with zero unique lines', B.zeroUnique.length, A.zeroUnique.length);
  row('Lines no other test file covers (whole suite)', B.suiteOnly, A.suiteOnly);
}
if (timing) for (const v of ['together', 'serial']) {
  const b = timing.summary[`before/${v}`], a = timing.summary[`after/${v}`];
  row(`Wall, ${v} (ms, median, min–max)`, `${b.wallMs.median} (${b.wallMs.min}–${b.wallMs.max})`, `${a.wallMs.median} (${a.wallMs.min}–${a.wallMs.max})`);
  row(`CPU, ${v} (ms, median, min–max)`, `${b.cpuMs.median} (${b.cpuMs.min}–${b.cpuMs.max})`, `${a.cpuMs.median} (${a.cpuMs.min}–${a.cpuMs.max})`);
}
for (const [k, v] of Object.entries(kills)) {
  if (!v.after) continue;
  const f = (s) => `${s.killed + s.timeout}/${s.run} = ${s.score}% (survived ${s.survived}, no coverage ${s.noCoverage})`;
  row(`Mutation, ${k}`, f(v.before.total), f(v.after.total));
}
if (pins.before) row('Pins (class / copy / style / source)', `${pins.before.class} / ${pins.before.copy} / ${pins.before.style} / ${pins.before.source}`, `${pins.after.class} / ${pins.after.copy} / ${pins.after.style} / ${pins.after.source}`);
