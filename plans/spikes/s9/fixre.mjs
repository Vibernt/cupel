#!/usr/bin/env node
// S9: the fix-commit regex, its counts, and its precision on a hand-judged sample.
//
// Usage:
//   node plans/spikes/s9/fixre.mjs sample   # draw the sample (seed 9) to results/fix-sample.json, print it for reading
//   node plans/spikes/s9/fixre.mjs sample2  # a second sample: 10 subject-only matches per suite not in the first
//                                           # (seed 10), to results/fix-sample-subject.json
//   node plans/spikes/s9/fixre.mjs score    # join the judgements, write results/fix-precision.json
//
// The sample has, per suite, 15 non-merge commits the regex (subject or body) matches and 15 it does not, drawn with
// a seeded Fisher-Yates shuffle (mulberry32, seed 9) from the commits in log order. Judgements: y = a bug-fix commit
// (it repairs behaviour that was wrong, broken or flaky), n = not one, p = partly (a feature or chore commit that also
// fixes a named bug). Precision counts y (strict) and y + p (lenient).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S9, SUITES, parseHistory, isFix, isMerge, FIX_RE, shuffle } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'sample';
const PER = 15;

const pools = {};
for (const suite of Object.keys(SUITES)) {
  const commits = parseHistory(join(S9, SUITES[suite].history)).filter((c) => !isMerge(c));
  pools[suite] = commits;
}

if (mode === 'sample') {
  const out = [];
  for (const [suite, commits] of Object.entries(pools)) {
    const hit = commits.filter((c) => isFix(c));
    const miss = commits.filter((c) => !isFix(c));
    for (const [cls, pool] of [['match', hit], ['nomatch', miss]]) {
      for (const c of shuffle(pool, 9).slice(0, PER)) {
        const m = FIX_RE.exec(`${c.subject}\n${c.body}`);
        out.push({ suite, cls, sha: c.sha.slice(0, 10), subject: c.subject, body: c.body.replace(/^co-authored-by:.*$/gim, '').trim().slice(0, 700), matched: m ? m[0] : null, inSubject: FIX_RE.test(c.subject) });
      }
    }
  }
  writeFileSync(join(HERE, 'results/fix-sample.json'), JSON.stringify(out, null, 1));
  out.forEach((x, i) => console.log(`\n#${i} [${x.suite} ${x.cls}${x.matched ? ` "${x.matched}"${x.inSubject ? ' subj' : ' body'}` : ''}] ${x.sha} ${x.subject}\n${x.body}`));
} else if (mode === 'sample2') {
  const first = new Set(JSON.parse(readFileSync(join(HERE, 'results/fix-sample.json'), 'utf8')).map((x) => x.sha));
  const out = [];
  for (const [suite, commits] of Object.entries(pools)) {
    const pool = commits.filter((c) => isFix(c, { subjectOnly: true }) && !first.has(c.sha.slice(0, 10)));
    for (const c of shuffle(pool, 10).slice(0, 10)) out.push({ suite, cls: 'subject', sha: c.sha.slice(0, 10), subject: c.subject, body: c.body.replace(/^co-authored-by:.*$/gim, '').trim().slice(0, 500), matched: FIX_RE.exec(c.subject)[0] });
  }
  writeFileSync(join(HERE, 'results/fix-sample-subject.json'), JSON.stringify(out, null, 1));
  out.forEach((x, i) => console.log(`\n#${i} [${x.suite} "${x.matched}"] ${x.sha} ${x.subject}\n${x.body}`));
} else {
  const sample = JSON.parse(readFileSync(join(HERE, 'results/fix-sample.json'), 'utf8'));
  const jpath = join(HERE, 'results/fix-judgements.json');
  if (!existsSync(jpath)) throw new Error('no fix-judgements.json');
  const J = JSON.parse(readFileSync(jpath, 'utf8')).judgements;
  if (J.length !== sample.length) throw new Error(`${J.length} judgements for ${sample.length} items`);
  const res = {};
  const bump = (k, j) => { res[k] ??= { n: 0, y: 0, p: 0, no: 0 }; res[k].n++; res[k][j === 'y' ? 'y' : j === 'p' ? 'p' : 'no']++; };
  sample.forEach((x, i) => {
    const j = J[i][0];
    bump(`${x.suite} ${x.cls}`, j);
    bump(`all ${x.cls}`, j);
    if (x.cls === 'match') bump(`all match-${x.inSubject ? 'subject' : 'body-only'}`, j);
  });
  // Second sample: subject-only matches.
  const s2 = JSON.parse(readFileSync(join(HERE, 'results/fix-sample-subject.json'), 'utf8'));
  const J2 = JSON.parse(readFileSync(join(HERE, 'results/fix-judgements-subject.json'), 'utf8')).judgements;
  if (J2.length !== s2.length) throw new Error(`${J2.length} subject judgements for ${s2.length} items`);
  s2.forEach((x, i) => { bump(`${x.suite} subject-2`, J2[i][0]); bump('all subject (both samples)', J2[i][0]); });
  sample.forEach((x, i) => { if (x.cls === 'match' && x.inSubject) bump('all subject (both samples)', J[i][0]); });
  const counts = {};
  for (const [suite, commits] of Object.entries(pools)) {
    counts[suite] = {
      nonMerge: commits.length,
      matchSubjectOrBody: commits.filter((c) => isFix(c)).length,
      matchSubject: commits.filter((c) => isFix(c, { subjectOnly: true })).length,
    };
  }
  // Recall estimate: of the fixes in the population, how many does the regex find? Using the sampled rates:
  // fixes ~ match * precision + nomatch * missRate.
  const est = {};
  for (const suite of Object.keys(pools)) {
    const m = res[`${suite} match`], u = res[`${suite} nomatch`];
    const prec = (m.y + m.p) / m.n, miss = (u.y + u.p) / u.n;
    const M = counts[suite].matchSubjectOrBody, U = counts[suite].nonMerge - M;
    est[suite] = { precisionLenient: +prec.toFixed(3), precisionStrict: +(m.y / m.n).toFixed(3), missRateLenient: +miss.toFixed(3), recallLenientEst: +((M * prec) / (M * prec + U * miss || 1)).toFixed(3) };
  }
  const out = { regex: FIX_RE.source, flags: 'i', counts, judged: res, estimates: est };
  writeFileSync(join(HERE, 'results/fix-precision.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
