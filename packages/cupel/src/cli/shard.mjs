// Fault-test slices for CI (D22). Cupel plans, runs one slice and merges; the CI system starts the
// machines, hands each its slice, moves the files and retries. Nothing here starts a machine.
//
//   planReport(plans, rule)   → the estimate per runner and the suggested number of slices
//   assignSlices(entries, n)  → which slice runs each fault (balanced by estimated time)
//   planDigest(entries, n)    → a fingerprint every slice records, so merge refuses mismatched plans
//   mergeMutations(...)       → one mutation from complete sets of slices

import { createHash } from 'node:crypto';
import { cmp, sortedUnique } from '../engine/order.mjs';
import { combineRunnerMutations } from './runner-mutations.mjs';
import { splitRunnerInput } from './merge-runners.mjs';

/** The default rule: one machine while the estimate fits the target time; else enough slices to fit it. */
export const DEFAULT_RULE = Object.freeze({ startupSeconds: 60, targetMinutes: 10, maxShards: 20 });

export function parseShard(text) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(text ?? '');
  if (!match) return null;
  const index = Number(match[1]); const total = Number(match[2]);
  return Number.isSafeInteger(index) && Number.isSafeInteger(total) && index <= total ? { index, total } : null;
}

/**
 * How many slices a runner's faults need. `estimateMs` is the serial time of its faults to run;
 * `parallel` the processes one machine runs at once for that runner.
 */
export function suggestShards(estimateMs, parallel, rule = DEFAULT_RULE) {
  const wallMs = estimateMs / Math.max(1, parallel);
  const targetMs = rule.targetMinutes * 60_000;
  if (wallMs <= targetMs) return 1;
  const usefulMs = Math.max(60_000, targetMs - rule.startupSeconds * 1000);
  return Math.min(rule.maxShards, Math.ceil(wallMs / usefulMs));
}

/**
 * Faults to slices: faults to run go, longest estimate first (then by id), to the slice with the least
 * estimated time so far (then the lowest index); reused and no-coverage rows cost nothing and go to
 * slice 1. Deterministic: every machine computes the same slices from the same plan.
 */
export function assignSlices(entries, total) {
  const out = new Map();
  const load = Array(total).fill(0);
  const run = entries.filter((e) => e.kind === 'run' && !e.after).sort((a, b) => (b.estimateMs - a.estimateMs) || cmp(a.id, b.id));
  for (const e of run) {
    let best = 0;
    for (let k = 1; k < total; k++) if (load[k] < load[best]) best = k;
    load[best] += Math.max(1, e.estimateMs);
    out.set(e.id, best + 1);
  }
  for (const e of entries) if (e.kind !== 'run') out.set(e.id, 1);
  // A second variant runs only after its first one survived, in the same slice.
  for (const e of entries) if (e.kind === 'run' && e.after) out.set(e.id, out.get(e.after) ?? 1);
  return out;
}

export function planDigest(runner, entries, total) {
  const rows = [...entries].sort((a, b) => cmp(a.id, b.id)).map((e) => [e.id, e.kind, e.estimateMs]);
  return `sha256:${createHash('sha256').update(JSON.stringify({ runner, total, rows })).digest('hex')}`;
}

/** The plan report: per runner, faults by kind, the estimate and the suggested slices; and in total. */
export function planReport(plans, { rule = DEFAULT_RULE, parallel = {} } = {}) {
  const runners = Object.entries(plans).sort(([a], [b]) => cmp(a, b)).map(([name, p]) => {
    if (!p?.plan) return { runner: name, sliceable: false, reason: p?.unsupported ?? 'no plan' };
    const count = (kind) => p.plan.filter((e) => e.kind === kind).length;
    const estimateMs = p.plan.reduce((n, e) => n + (e.kind === 'run' ? e.estimateMs : 0), 0);
    const par = parallel[name] ?? 1;
    const shards = suggestShards(estimateMs, par, rule);
    return { runner: name, sliceable: true, faults: { run: count('run'), reused: count('reused'), noCoverage: count('no-coverage') },
      sampled: !!p.sampled, estimateSeconds: Math.round(estimateMs / 1000), parallel: par,
      expectedMinutes: Math.round((estimateMs / par / shards / 60_000 + (shards > 1 ? rule.startupSeconds / 60 : 0)) * 10) / 10,
      suggestedShards: shards };
  });
  return { kind: 'cupel-mutation-plan', rule, runners };
}

const without = (doc) => { const { mutation: _m, ...rest } = doc; return JSON.stringify(rest); };

/**
 * Joins slices (inputs with mutation, each from `cupel mutate --shard`, or a whole run) into one.
 * Every file must hold the same collected input as `base`; for each runner either one whole run
 * or every slice 1..n of one plan; no fault twice. `targeted` keeps the units every slice of a
 * runner lists; `sampled` is true when any part was sampled or a slice stopped early.
 */
export function mergeMutations(base, parts) {
  const fail = (message) => { throw new Error(message); };
  const reference = without(base);
  const groups = new Map();
  for (const { name, doc } of parts) {
    if (!doc?.mutation) fail(`${name}: no mutation`);
    if (without(doc) !== reference) fail(`${name}: holds a different collected input than --input`);
    const shard = doc.mutation.shard ?? { runner: '*', index: 1, total: 1, plan: null };
    const key = `${shard.runner}\0${shard.total}\0${shard.plan}`;
    if (!groups.has(key)) groups.set(key, { ...shard, parts: new Map() });
    const group = groups.get(key);
    if (group.parts.has(shard.index)) fail(`${name}: slice ${shard.index}/${shard.total} of ${shard.runner} appears twice`);
    group.parts.set(shard.index, { name, mutation: doc.mutation });
  }
  const runners = new Map();
  for (const g of groups.values()) {
    if (runners.has(g.runner)) fail(`runner ${g.runner}: slices from different plans (or a whole run and slices); rerun every slice from one plan`);
    runners.set(g.runner, g);
    for (let k = 1; k <= g.total; k++) if (!g.parts.has(k)) fail(`runner ${g.runner}: slice ${k}/${g.total} is missing`);
  }
  if (runners.has('*') && runners.size > 1) fail('a run of every runner cannot be merged with runner slices');
  let sampled = false; const seeds = new Set(); const perRunner = [];
  for (const g of [...runners.values()].sort((a, b) => cmp(a.runner, b.runner))) {
    let groupTargeted = null; const mutants = []; const seen = new Set();
    for (const { name, mutation } of [...g.parts.values()]) {
      // Within one runner a fault belongs to one slice; runners sharing a source report it once each (K14).
      for (const m of mutation.mutants) { if (seen.has(m.id)) fail(`${name}: fault ${m.id} is in two parts`); seen.add(m.id); mutants.push(m); }
      const t = new Set(mutation.targeted ?? []);
      groupTargeted = groupTargeted === null ? t : new Set([...groupTargeted].filter((u) => t.has(u)));
      sampled ||= !!mutation.sampled;
      if (mutation.seed !== undefined) seeds.add(mutation.seed);
    }
    perRunner.push({ name: g.runner, mutation: { mutants, targeted: [...(groupTargeted ?? [])] } });
  }
  if (seeds.size > 1) fail('slices used different seeds');
  const modes = new Set(parts.map(({ doc }) => doc.mutation.catches ?? 'all'));
  if (modes.size > 1) fail('some parts stopped at the first catch and others did not; run every part the same way');
  let mutants; let targeted;
  if (perRunner.length > 1) {
    const byName = new Map(splitRunnerInput(base).map((p) => [p.name, p.input]));
    let combined;
    try { combined = combineRunnerMutations(perRunner.map((r) => ({ ...r, part: byName.get(r.name) }))).mutation; }
    catch (error) { fail(error.message); }
    mutants = combined.mutants; targeted = combined.targeted; sampled ||= !!combined.sampled;
  } else {
    mutants = perRunner.flatMap((r) => r.mutation.mutants);
    targeted = sortedUnique(perRunner.flatMap((r) => r.mutation.targeted));
  }
  return { mutants: mutants.sort((a, b) => cmp(a.id, b.id)), targeted, sampled, ...(seeds.size ? { seed: [...seeds][0] } : {}),
    ...(modes.has('first') ? { catches: 'first' } : {}) };
}
