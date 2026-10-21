#!/usr/bin/env node
// S6 hand-check helper: print one sampled suggestion with its signals, the test's source, and the sibling it is
// compared with. Read-only.
//
// Usage: node plans/spikes/s6/show.mjs --sample <sample.json> --brittle <brittle.json> --root <suite> --n <index> [--input <input.json>]
// With --input, also prints the test's own lines grouped by source file (setup removed) and, for a subset sibling,
// what the sibling covers in addition.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2));
const sample = JSON.parse(readFileSync(opt.sample, 'utf8'));
const brittle = JSON.parse(readFileSync(opt.brittle, 'utf8')).tests;
const s = sample[Number(opt.n)];
const src = (file, name) => {
  const n = name.replace(/\[.*\]$/, '');
  const b = brittle.find((t) => t.file === file && (t.name === n || (t.pattern && new RegExp(`^${t.pattern}$`).test(n))));
  if (!b) return `(no source range for ${name})`;
  const lines = readFileSync(join(opt.root, file), 'utf8').split('\n');
  return lines.slice(b.line - 1, Math.min(b.endLine, b.line + 70)).map((l, k) => `${String(b.line + k).padStart(4)} ${l.slice(0, 220)}`).join('\n');
};
console.log(`#${opt.n} [${s.class}] ${s.id}`);
console.log(`advice: ${s.advice}; tier: ${s.tier ?? (s.critical ? 'critical' : '')}`);
console.log(`reasons: ${(s.reasons ?? []).join(' | ')}`);
if (s.kind === 'files') { console.log(JSON.stringify({ files: s.files, target: s.target, tests: s.tests, ms: s.ms })); process.exit(0); }
console.log(`signals: ${JSON.stringify(s.signals)}`);
console.log('--- test');
console.log(src(s.file, s.name));
let input = null;
if (opt.input) {
  input = JSON.parse(readFileSync(opt.input, 'utf8'));
  const setup = new Set(input.setupLines);
  const byId = new Map(input.tests.map((t) => [t.id, t]));
  const group = (ls) => { const g = {}; for (const l of ls) { if (setup.has(l)) continue; const k = input.lineKeys[l]; const p = k.slice(0, k.lastIndexOf(':')); (g[p] ??= []).push(Number(k.slice(k.lastIndexOf(':') + 1))); } return g; };
  const me = byId.get(s.id);
  const g = group(me.lines);
  console.log('--- own lines by file (setup removed):');
  for (const [p, ls] of Object.entries(g).sort((a, b) => b[1].length - a[1].length).slice(0, 12)) console.log(`  ${p}: ${ls.length} [${ls.sort((a, b) => a - b).slice(0, 25).join(',')}${ls.length > 25 ? ',…' : ''}]`);
  // Who else covers this test's own lines (top 6 by overlap).
  const mine0 = new Set(me.lines.filter((l) => !setup.has(l)));
  const overlap = [];
  for (const o of input.tests) {
    if (o.id === me.id) continue;
    let n = 0;
    for (const l of o.lines) if (mine0.has(l)) n++;
    if (n) overlap.push([n, o.id]);
  }
  overlap.sort((a, b) => b[0] - a[0]);
  console.log(`--- other tests covering its ${mine0.size} lines (${overlap.length} tests): ${overlap.slice(0, 6).map(([n, id]) => `${n} ${id.slice(0, 110)}`).join('\n    ')}`);
  const sib = s.signals.subsetOf ?? (s.advice === 'consolidate' ? s.signals.nearest : null);
  if (sib) {
    console.log(`--- sibling: ${sib}`);
    const o = byId.get(sib);
    const mine = new Set(me.lines);
    const extra = group(o.lines.filter((l) => !mine.has(l)));
    console.log(`  sibling covers in addition: ${Object.entries(extra).map(([p, ls]) => `${p}:${ls.length}`).slice(0, 8).join(', ')}`);
    console.log(src(o.file, o.name).split('\n').slice(0, 30).join('\n'));
  }
}
