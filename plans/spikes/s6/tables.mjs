#!/usr/bin/env node
// S6: join the drawn samples with the hand-check judgements; write results/handcheck-<suite>.json and print the
// markdown tables and the precision per advice class.
//
// Usage: node plans/spikes/s6/tables.mjs --out /abs/out-s6 [--md]
// Rounds are the keys of results/judgements.json per suite; a '-firstrun' round reads sample-*-buggyrun.json.
// Precision: strict = correct / judged; lenient = (correct + debatable) / judged.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../s2/exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2));
const J = JSON.parse(readFileSync(join(HERE, 'results/judgements.json'), 'utf8'));
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const signalText = (x) => {
  if (x.kind === 'files') return `files ${x.files.length}, tests ${x.tests}, target ${x.target}`;
  const s = x.signals;
  const parts = [`own ${s.ownLines}`, `uniq ${s.uniqueLines}`];
  if (s.recheckUniqueLines !== undefined) parts.push(`recheck uniq ${s.recheckUniqueLines}`);
  if (s.evidence === 'mutation+coverage') parts.push(`kills ${s.kills}, uniq kills ${s.uniqueKills}`);
  if (s.brittle?.length) parts.push(s.brittle.join('+'));
  if (x.advice === 'rewrite' && /slow/.test(x.reasons.join())) parts.push(`${s.ms} ms`);
  if (s.shapeSimilarity) parts.push(`shape ${s.shapeSimilarity}`);
  if (s.rows) parts.push(`${s.rows} rows`);
  parts.push(x.tier);
  return parts.join(', ');
};
const summary = {};
for (const suite of ['assay', 'cc']) {
  const rows = [];
  const rounds = Object.keys(J[suite]);
  for (const round of rounds) {
    const sample = JSON.parse(readFileSync(join(opt.out, suite, `sample-${round.replace('-firstrun', '-buggyrun')}.json`), 'utf8'));
    const judged = J[suite][round];
    if (judged.length !== sample.length) throw new Error(`${suite} ${round}: ${judged.length} judgements for ${sample.length} items`);
    sample.forEach((x, i) => {
      const [j, reason, fp] = judged[i];
      rows.push({ suite, round, n: i, class: x.class, id: x.id, signals: signalText(x), advice: x.advice, reasons: x.reasons, judgement: { c: 'correct', w: 'wrong', d: 'debatable' }[j], reason, fp: fp || null });
    });
  }
  writeFileSync(join(HERE, `results/handcheck-${suite}.json`), JSON.stringify(rows, null, 1));
  for (const round of rounds) {
    const r = rows.filter((x) => x.round === round);
    for (const cls of ['retire', 'consolidate', 'rewrite']) {
      const c = r.filter((x) => x.class === cls);
      const k = (j) => c.filter((x) => x.judgement === j).length;
      (summary[suite] ??= {})[`${round}:${cls}`] = { judged: c.length, correct: k('correct'), debatable: k('debatable'), wrong: k('wrong'),
        strict: c.length ? Math.round((100 * k('correct')) / c.length) : null, lenient: c.length ? Math.round((100 * (k('correct') + k('debatable'))) / c.length) : null };
    }
    const fps = {};
    for (const x of r) if (x.judgement !== 'correct' && x.fp) fps[x.fp] = (fps[x.fp] ?? 0) + 1;
    summary[suite][`${round}:causes`] = fps;
  }
  if (opt.md) {
    for (const round of rounds) {
      console.log(`\n#### ${suite} ${round}\n\n| # | Advice | Test (or files) | Signals | Judgement | Reason |\n|---|---|---|---|---|---|`);
      for (const x of rows.filter((y) => y.round === round)) console.log(`| ${x.n} | ${x.class} | ${short(x.id.replace(/\|/g, '/'), 110)} | ${x.signals} | ${x.judgement} | ${x.reason.replace(/\|/g, '/')} |`);
    }
  }
}
writeFileSync(join(HERE, 'results/precision.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
