#!/usr/bin/env node
// S4 timing: wall and CPU time of sets of test files, interleaved so machine load falls on every set alike.
//
// Usage:
//   node plans/spikes/s4/timing.mjs --root /abs/suite --out /abs/out-s4 --reps 5 \
//     --set before=tests/a.test.mjs,tests/b.test.mjs --set after=tests/x.test.mjs [--tag t]
//
// Per repeat and per set (the set order alternates between repeats):
//   together  `node --test <every file of the set>` (one runner, files in parallel processes, as the suite runs)
//   serial    `node --test <file>` for each file in turn; wall and CPU are summed over the files
// Wall time from hrtime; CPU (user + sys, the process and its children) from /usr/bin/time -p (10 ms resolution).
// Every run must pass all its tests. Writes <out>/timing[-tag].json and prints medians with min–max.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { timed, median } from '../s2/exec.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const sets = argv.flatMap((a, i) => (a === '--set' ? [argv[i + 1]] : [])).map((s) => { const [name, files] = s.split('='); return { name, files: files.split(',') }; });
const root = get('root'), out = get('out'), reps = Number(get('reps', '5')), tag = get('tag', '');
if (!root || !out || !sets.length) { console.error('usage: node timing.mjs --root <suite> --out <dir> [--reps n] --set name=a,b [--set ...]'); process.exit(2); }
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_V8_COVERAGE;
delete env.NODE_OPTIONS;
const logDir = join(out, 'timing-logs');
mkdirSync(logDir, { recursive: true });

const passCount = (log) => {
  const text = readFileSync(log, 'utf8');
  const n = (k) => Number((text.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) || [0, NaN])[1]);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail') };
};
const rows = [];
for (let rep = 1; rep <= reps; rep++) {
  const order = rep % 2 ? sets : [...sets].reverse();
  for (const set of order) {
    const log = join(logDir, `${set.name}-together-r${rep}.txt`);
    const t = timed([process.execPath, '--test', ...set.files], { cwd: root, env, log });
    const c = passCount(log);
    if (t.code !== 0 || c.fail || c.pass !== c.tests) throw new Error(`${set.name} together r${rep} failed: ${JSON.stringify(c)}`);
    rows.push({ rep, set: set.name, variant: 'together', wallMs: t.wallMs, cpuMs: t.cpuMs, tests: c.tests, load1: loadavg()[0] });
    let wall = 0, cpu = 0, tests = 0;
    for (const f of set.files) {
      const flog = join(logDir, `${set.name}-serial-r${rep}-${f.replace(/\W+/g, '_')}.txt`);
      const s = timed([process.execPath, '--test', f], { cwd: root, env, log: flog });
      const fc = passCount(flog);
      if (s.code !== 0 || fc.fail) throw new Error(`${set.name} ${f} r${rep} failed`);
      wall += s.wallMs; cpu += s.cpuMs; tests += fc.tests;
    }
    rows.push({ rep, set: set.name, variant: 'serial', wallMs: wall, cpuMs: cpu, tests, load1: loadavg()[0] });
    console.log(`r${rep} ${set.name.padEnd(8)} together wall ${t.wallMs.toFixed(0)} cpu ${t.cpuMs.toFixed(0)} | serial wall ${wall.toFixed(0)} cpu ${cpu.toFixed(0)} | tests ${c.tests} | load ${loadavg()[0].toFixed(1)}`);
  }
}
const summary = {};
for (const set of sets) for (const variant of ['together', 'serial']) {
  const rs = rows.filter((r) => r.set === set.name && r.variant === variant);
  const stat = (k) => ({ median: Math.round(median(rs.map((r) => r[k]))), min: Math.round(Math.min(...rs.map((r) => r[k]))), max: Math.round(Math.max(...rs.map((r) => r[k]))) });
  summary[`${set.name}/${variant}`] = { reps: rs.length, tests: rs[0].tests, wallMs: stat('wallMs'), cpuMs: stat('cpuMs'), load1: stat('load1') };
}
writeFileSync(join(out, `timing${tag ? `-${tag}` : ''}.json`), JSON.stringify({ node: process.version, reps, sets, rows, summary }, null, 1));
for (const [k, v] of Object.entries(summary))
  console.log(`${k.padEnd(18)} wall ${v.wallMs.median} (${v.wallMs.min}–${v.wallMs.max}) ms, cpu ${v.cpuMs.median} (${v.cpuMs.min}–${v.cpuMs.max}) ms, tests ${v.tests}`);
