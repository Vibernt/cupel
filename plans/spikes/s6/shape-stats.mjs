#!/usr/bin/env node
// S6: distribution of body-shape similarity between same-file tests (rows grouped), to calibrate the v1
// consolidate threshold. Read-only.
// Usage: node plans/spikes/s6/shape-stats.mjs <input.json>

import { readFileSync } from 'node:fs';
import { groupRows } from './engine.mjs';

const input = groupRows(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const sh = (shape) => { const t = (shape ?? '').split(' ').filter(Boolean); const s = new Set(); for (let i = 0; i + 4 <= t.length; i++) s.add(t.slice(i, i + 4).join(' ')); return s; };
const jac = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const byFile = new Map();
input.tests.forEach((t, i) => { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(i); });
const shapes = input.tests.map((t) => sh(t.shape));
const best = input.tests.map((t, i) => { let b = 0, bj = -1; for (const j of byFile.get(t.file)) if (j !== i) { const s = jac(shapes[i], shapes[j]); if (s > b) { b = s; bj = j; } } return [b, bj]; });
const buckets = [0.3, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0001];
for (const th of buckets) console.log(`>= ${th}: ${best.filter(([b]) => b >= th).length}`);
const top = best.map(([b, j], i) => [b, i, j]).filter(([b]) => b >= 0.6).sort((a, b) => b[0] - a[0]).slice(0, 12);
for (const [b, i, j] of top) console.log(b.toFixed(2), input.tests[i].id.slice(0, 90), '~', input.tests[j].name.slice(0, 60));
