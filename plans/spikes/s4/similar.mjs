#!/usr/bin/env node
// S4: which tests look alike? Signals a tool could use to propose "consolidate" groups, from the per-test data.
//
// Usage:
//   node plans/spikes/s4/similar.mjs --out /abs/out-s4 --cover before-r1,before-r2,before-r3 --kills /abs/out-s4/mut-before-area,... \
//     [--threshold 0.8] [--root /abs/suite]
//
// For every pair of tests it reports:
//   jaccard   of the lines each covers outside module load, in every repeat (cover.mjs output);
//   subset    whether one test's lines are contained in the other's;
//   killsSub  whether one test's killed mutants are contained in the other's (from S3 runs; kills.mjs's rule);
//   route     with --root: the first route each test opens (harness.open('<path>')), when both open the same one;
//   helpers   the pure functions both call (identifiers imported by the file and called in both test bodies).
// Then a greedy grouping: tests joined by jaccard >= threshold, or by the same route, or by sharing a called helper.
// Prints the groups and the pairs; writes <out>/similar.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2), { threshold: '0.8' });
const jsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reps = String(opt.cover).split(',').map((n) => JSON.parse(readFileSync(join(opt.out, 'cover', `${n}.json`), 'utf8')));
const setup = new Set(reps.flatMap((r) => Object.values(r.files).flatMap((f) => f.setup)));
const tests = new Map();
for (const [file, f] of Object.entries(reps[0].files)) for (const name of Object.keys(f.tests)) {
  const sets = reps.map((r) => new Set((r.files[file]?.tests[name] || []).filter((k) => !setup.has(k))));
  tests.set(`${file} :: ${name}`, { file, name, lines: new Set([...sets[0]].filter((k) => sets.every((s) => s.has(k)))), kills: new Set() });
}
for (const dir of String(opt.kills || '').split(',').filter(Boolean)) {
  const byId = new Map(jsonl(join(dir, 'results.jsonl')).map((r) => [r.id, r]));
  for (const r of jsonl(join(dir, 'recheck.jsonl'))) if (byId.get(r.id)?.status === 'timeout') byId.set(r.id, r);
  for (const r of byId.values()) for (const f of r.files || []) for (const t of f.failed || []) tests.get(`${f.file} :: ${t}`)?.kills.add(r.id);
}
// Static signals from the test source: the first route opened, and the imported helpers called.
if (opt.root) {
  for (const file of new Set([...tests.values()].map((t) => t.file))) {
    const src = readFileSync(join(opt.root, file), 'utf8');
    const imported = new Set([...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\.\/(?:public|src)\//g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)));
    const starts = [...src.matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)];
    starts.forEach((m, i) => {
      const body = src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length);
      const t = tests.get(`${file} :: ${m[2]}`);
      if (!t) return;
      t.route = body.match(/\.open\(\s*[`'"]([^`'"?]+)/)?.[1] ?? null;
      t.helpers = new Set([...imported].filter((id) => new RegExp(`\\b${id}\\(`).test(body)));
    });
  }
}
const ids = [...tests.keys()];
const pairs = [];
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = tests.get(ids[i]), b = tests.get(ids[j]);
  const inter = [...a.lines].filter((k) => b.lines.has(k)).length;
  const union = a.lines.size + b.lines.size - inter;
  const jaccard = union ? inter / union : 0;
  const subset = (a.lines.size && inter === a.lines.size) ? 'a⊆b' : (b.lines.size && inter === b.lines.size) ? 'b⊆a' : '';
  const ki = [...a.kills].filter((k) => b.kills.has(k)).length;
  const killsSub = (a.kills.size && ki === a.kills.size) ? 'a⊆b' : (b.kills.size && ki === b.kills.size) ? 'b⊆a' : '';
  const route = a.route && a.route === b.route ? a.route : null;
  const helpers = a.helpers && b.helpers ? [...a.helpers].filter((h) => b.helpers.has(h)) : [];
  if (jaccard >= 0.5 || subset || route || helpers.length) pairs.push({ a: ids[i], b: ids[j], jaccard: Math.round(jaccard * 100) / 100, subset, killsSub, route, helpers, sizes: [a.lines.size, b.lines.size], kills: [a.kills.size, b.kills.size] });
}
// Union-find over the signals.
const parent = new Map(ids.map((id) => [id, id]));
const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
for (const p of pairs) if (p.jaccard >= Number(opt.threshold) || p.route || p.helpers.length) parent.set(find(p.a), find(p.b));
const groups = {};
for (const id of ids) (groups[find(id)] ||= []).push(id);
const multi = Object.values(groups).filter((g) => g.length > 1);
for (const g of multi) console.log(`group of ${g.length}:\n  ${g.map((x) => x.replace(/^tests\//, '').slice(0, 110)).join('\n  ')}`);
console.log(`${multi.length} groups covering ${multi.flat().length} of ${ids.length} tests; ${pairs.filter((p) => p.jaccard >= Number(opt.threshold)).length} pairs with jaccard >= ${opt.threshold}; ${pairs.filter((p) => p.subset).length} subset pairs`);
writeFileSync(join(opt.out, 'similar.json'), JSON.stringify({ threshold: Number(opt.threshold), groups: multi, pairs }, null, 1));
