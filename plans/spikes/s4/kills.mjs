#!/usr/bin/env node
// S4: compare two mutation runs of S3's runner (plans/spikes/s3/run.mjs) on the same mutants.
//
// Usage:
//   node plans/spikes/s4/kills.mjs --before /abs/out-s4/mut-before-area --after /abs/out-s4/mut-after-area [--json out.json]
//   node plans/spikes/s4/kills.mjs --before /abs/out-s4/mut-before-area            (one run: per-test kills only)
//
// Reads each run's mutants.json, results.jsonl and recheck.jsonl. A timeout that was re-run replaces the first result.
// Status is re-derived with S3's strict rule: killed = a file reported a failing test; timeout = only timeouts
// (counted as a kill, as S3 does); a non-zero exit with no failing test is an environment error.
// Reports per module: run, killed, timeout, survived, no coverage, score; the sampled mutant ids must be identical in
// both runs (same seed, same sources). Per test: kills, and unique kills (the only killing test of that mutant, in
// the whole run). The guardrail: every mutant killed before is killed after. Exit 1 when it fails.
// --flaky 'tests/x.test.mjs :: name|...': failures of these tests do not count as kills, on both sides (for a test
// that also fails unmutated, such as Assay's load-sensitive demo-workspace determinism check).
// --confirmed file.json ({ "mutants": { "<id>": { "status": "survived", ... } } }): statuses settled by re-runs
// (rerun.mjs), applied to both runs; use it only for mutants whose kill rests on a test that fails unmutated.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2));
if (!opt.before) { console.error('usage: node kills.mjs --before <run dir> [--after <run dir>] [--json <file>]'); process.exit(2); }
const FLAKY = new Set(String(opt.flaky || '').split('|').filter(Boolean));
const CONFIRMED = opt.confirmed ? JSON.parse(readFileSync(opt.confirmed, 'utf8')).mutants : {};
const jsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function loadRun(dir) {
  const { modules, seed } = JSON.parse(readFileSync(join(dir, 'mutants.json'), 'utf8'));
  const byId = new Map(jsonl(join(dir, 'results.jsonl')).map((r) => [r.id, r]));
  for (const r of jsonl(join(dir, 'recheck.jsonl'))) if (byId.get(r.id)?.status === 'timeout') byId.set(r.id, r);
  const mutants = [];
  for (const [module, info] of Object.entries(modules)) for (const m of info.mutants) {
    const r = byId.get(m.id);
    if (!r) throw new Error(`${dir}: no result for ${m.id}`);
    // --flaky: failures of these tests are not counted as kills (a test that also fails unmutated under load).
    const files = (r.files || []).map((f) => {
      const failed = f.failed.filter((t) => !FLAKY.has(`${f.file} :: ${t}`));
      return { ...f, failed, killed: failed.length > 0 || f.timedOut };
    });
    const killers = files.filter((f) => f.killed);
    let status = r.status;
    if (['killed', 'timeout'].includes(status)) status = killers.some((f) => !f.timedOut) ? 'killed' : killers.length ? 'timeout' : FLAKY.size ? 'survived' : 'error';
    // --confirmed: statuses settled by re-running a disputed mutant (rerun.mjs), applied to every run alike.
    if (CONFIRMED[m.id]) status = CONFIRMED[m.id].status;
    const tests = killers.flatMap((f) => (f.timedOut ? [`${f.file} :: <timeout>`] : f.failed.map((t) => `${f.file} :: ${t}`)));
    mutants.push({ id: m.id, module, line: m.line, op: m.op, original: m.original, replacement: m.replacement, status, selected: m.tests.length, complete: r.complete, tests });
  }
  const idsHash = createHash('sha256').update(mutants.map((m) => m.id).join('\n')).digest('hex').slice(0, 16);
  return { dir, seed, mutants, idsHash };
}

function summarise(run) {
  const modules = {};
  for (const m of run.mutants) {
    const s = (modules[m.module] ||= { run: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0 });
    s.run++;
    s[{ killed: 'killed', timeout: 'timeout', survived: 'survived', 'no-coverage': 'noCoverage' }[m.status] || 'error']++;
  }
  const total = { run: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0 };
  for (const s of Object.values(modules)) {
    s.score = Math.round(1000 * (s.killed + s.timeout) / s.run) / 10;
    for (const k of Object.keys(total)) total[k] += s[k];
  }
  total.score = Math.round(1000 * (total.killed + total.timeout) / total.run) / 10;
  const perTest = {};
  for (const m of run.mutants) {
    if (!['killed', 'timeout'].includes(m.status)) continue;
    for (const t of m.tests) {
      const p = (perTest[t] ||= { kills: 0, unique: 0, uniqueIds: [] });
      p.kills++;
      if (m.tests.length === 1) { p.unique++; p.uniqueIds.push(m.id); }
    }
  }
  return { seed: run.seed, idsHash: run.idsHash, modules, total, perTest, incomplete: run.mutants.filter((m) => m.complete === false).length };
}

const before = loadRun(opt.before);
const sb = summarise(before);
const out = { before: { dir: opt.before, ...sb } };
const fmt = (s) => `${s.killed + s.timeout}/${s.run} = ${s.score}% (killed ${s.killed}, timeout ${s.timeout}, survived ${s.survived}, no coverage ${s.noCoverage}${s.error ? `, env errors ${s.error}` : ''})`;
console.log(`before: seed ${sb.seed}, mutant ids ${sb.idsHash}`);
for (const [m, s] of Object.entries(sb.modules)) console.log(`  ${m.padEnd(10)} ${fmt(s)}`);
console.log(`  ${'all'.padEnd(10)} ${fmt(sb.total)}`);
let ok = true;
if (opt.after) {
  const after = loadRun(opt.after);
  const sa = summarise(after);
  out.after = { dir: opt.after, ...sa };
  console.log(`after:  seed ${sa.seed}, mutant ids ${sa.idsHash}`);
  for (const [m, s] of Object.entries(sa.modules)) console.log(`  ${m.padEnd(10)} ${fmt(s)}`);
  console.log(`  ${'all'.padEnd(10)} ${fmt(sa.total)}`);
  const sameSet = sb.idsHash === sa.idsHash && sb.seed === sa.seed;
  const a = new Map(after.mutants.map((m) => [m.id, m]));
  const isKill = (m) => m && ['killed', 'timeout'].includes(m.status);
  const lost = before.mutants.filter((m) => isKill(m) && !isKill(a.get(m.id)));
  const gained = before.mutants.filter((m) => !isKill(m) && isKill(a.get(m.id)));
  const statusChanged = before.mutants.filter((m) => a.get(m.id)?.status !== m.status);
  out.sameMutants = sameSet;
  out.lost = lost.map((m) => ({ id: m.id, before: m.status, after: a.get(m.id)?.status, killedBy: m.tests }));
  out.gained = gained.map((m) => ({ id: m.id, before: m.status, after: a.get(m.id).status, killedBy: a.get(m.id).tests }));
  out.statusChanged = statusChanged.map((m) => ({ id: m.id, before: m.status, after: a.get(m.id)?.status }));
  ok = sameSet && lost.length === 0 && sa.total.score >= sb.total.score && Object.keys(sb.modules).every((k) => sa.modules[k].score >= sb.modules[k].score);
  console.log(`same mutant set: ${sameSet}; killed before but not after: ${lost.length}; killed after only: ${gained.length}; status changes: ${statusChanged.length}`);
  for (const m of out.lost) console.log(`  LOST ${m.id} (${m.before} -> ${m.after}) was killed by ${m.killedBy.join(' | ')}`);
  for (const m of out.gained) console.log(`  GAINED ${m.id} (${m.before} -> ${m.after}) by ${m.killedBy.join(' | ')}`);
  console.log(`guardrail (same mutants, no kill lost, score per module and overall equal or better): ${ok ? 'pass' : 'fail'}`);
}
if (opt.json) writeFileSync(opt.json, JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
