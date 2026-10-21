#!/usr/bin/env node
// S6: draw a seeded, stratified sample of advice for hand-checking.
//
// Usage: node plans/spikes/s6/sample.mjs --report <report.json> --seed 6 [--per 10] [--exclude a.json,b.json] --out <sample.json>
// Draws --per suggestions from each of retire, consolidate (tests and file groups together) and rewrite; a class
// with fewer suggestions gives all it has. Ids in the --exclude samples are skipped (a fresh sample after tuning).
// The order of candidates is the report order (sorted by id), shuffled with a seeded Fisher-Yates (mulberry32).

import { readFileSync, writeFileSync } from 'node:fs';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2), { per: '10', seed: '6' });
const report = JSON.parse(readFileSync(opt.report, 'utf8'));
const excluded = new Set((opt.exclude ? opt.exclude.split(',') : []).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).map((s) => s.id)));
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(Number(opt.seed));
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pools = {
  retire: report.tests.filter((t) => t.advice === 'retire').map((t) => ({ kind: 'test', ...t })),
  consolidate: [
    ...report.tests.filter((t) => t.advice === 'consolidate').map((t) => ({ kind: 'test', ...t })),
    ...report.groups.map((g) => ({ kind: 'files', id: `files: ${g.files.join(', ')}`, advice: 'consolidate', ...g })),
  ],
  rewrite: report.tests.filter((t) => t.advice === 'rewrite').map((t) => ({ kind: 'test', ...t })),
};
const out = [];
for (const [cls, pool] of Object.entries(pools)) {
  const picked = shuffle(pool.filter((x) => !excluded.has(x.id))).slice(0, Number(opt.per));
  for (const p of picked) out.push({ class: cls, ...p });
  console.log(`${cls}: pool ${pool.length}, picked ${picked.length}`);
}
writeFileSync(opt.out, JSON.stringify(out, null, 1));
