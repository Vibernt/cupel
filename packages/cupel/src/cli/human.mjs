// Human output. Short and plain: colour only when stdout is a TTY and NO_COLOR is not set.

import { cmp } from '../engine/order.mjs';

const ADVICE_ORDER = ['consolidate', 'rewrite', 'move-to-check', 'none'];

export function painter(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { red: wrap('31'), green: wrap('32'), yellow: wrap('33'), dim: wrap('2'), bold: wrap('1') };
}

const pct = (r) => (r.pct === null ? 'n/a' : `${r.pct}%`);
const score = (m) => (m === null ? 'n/a' : m.score === null ? 'n/a' : `${m.score}%`);
const lostText = (lost) => {
  const parts = Object.entries(lost?.lines ?? {}).map(([p, l]) => `${p}:${l}`);
  if (lost?.mutants?.length) parts.push(`mutants ${lost.mutants.join(', ')}`);
  return parts.join('; ');
};

function diagnostics(report, c) {
  return (report.diagnostics ?? []).map((d) => {
    const sev = d.severity === 'error' ? c.red(d.severity) : c.yellow(d.severity);
    const where = [d.path, d.test].filter(Boolean).join(' ');
    return `${sev} ${d.code}${where ? ` ${where}` : ''}${d.message ? `: ${d.message}` : ''}`;
  });
}

export function summaryLine(s) {
  return `${s.tests} tests, ${s.units} units, coverage ${pct(s.coverage)} (${s.coverage.covered}/${s.coverage.coverable}), mutation score ${score(s.mutation)}`;
}

function report(r, c) {
  const out = [summaryLine(r.suite)];
  for (const advice of ADVICE_ORDER) {
    const units = r.units.filter((u) => u.advice === advice);
    if (!units.length) continue;
    out.push('', c.bold(`${advice} (${units.length})`));
    for (const u of units) {
      const extra = [];
      if (u.group) extra.push(`group ${u.group}`);
      if (u.duplicateOf) extra.push(`duplicate of ${u.duplicateOf}`);
      const why = [...u.reasons, ...extra].join(', ');
      out.push(`  ${u.id}${why ? c.dim(`  ${why}`) : ''}`);
    }
  }
  const hints = new Map();
  for (const u of r.units) for (const h of u.hints) hints.set(h, (hints.get(h) ?? 0) + 1);
  for (const f of r.files ?? []) for (const h of f.hints) hints.set(h, (hints.get(h) ?? 0) + 1);
  if (hints.size) {
    out.push('', 'hints');
    for (const [h, n] of [...hints.entries()].sort(([a], [b]) => cmp(a, b))) out.push(`  ${h}: ${n}`);
  }
  return out;
}

function label(r, c) {
  const out = [summaryLine(r.suite)];
  for (const u of r.units) {
    const tier = u.tier === 'critical' ? c.bold(u.tier.padEnd(8)) : u.tier.padEnd(8);
    out.push(`${tier}  ${u.id}${c.dim(`  ${u.tierReason}${u.protected ? ', protected' : ''}`)}`);
  }
  return out;
}

function plan(r, c) {
  const p = r.plan;
  const out = [`plan (${p.mode}): ${p.order.length} units, expected ${p.expectedMs} ms`];
  for (const e of p.order) out.push(`  ${e.bucket.padEnd(8)}  ${String(e.durationMs).padStart(6)} ms  ${e.id}`);
  if (p.skipped.length) {
    out.push(c.dim(`skipped (${p.skipped.length})`));
    for (const id of p.skipped) out.push(c.dim(`  ${id}`));
  }
  return out;
}

function check(r, c) {
  return r.check.verdicts.map((v) => {
    const colour = ['adds-value', 'no-unique-evidence'].includes(v.verdict) ? c.green : c.red;
    const extra = [];
    if (v.verdict === 'no-unique-evidence') extra.push(v.extend ? `extend ${v.extend}` : 'overlaps nothing');
    if (v.lost) extra.push(`lost ${lostText(v.lost)}`);
    if (v.brittle.length) extra.push(`brittle ${v.brittle.join(', ')}`);
    return `${colour(v.verdict)}  ${v.id}${extra.length ? c.dim(`  ${extra.join('; ')}`) : ''}`;
  });
}

function review(r, c) {
  const pack = r.review;
  const out = [`review: ${pack.candidates.length} candidates (${pack.critical} critical)`, pack.notice];
  for (const candidate of pack.candidates) {
    const e = candidate.evidence;
    out.push('', `${candidate.unit}  ${candidate.tier} / ${candidate.status}  ${candidate.reasons.join(', ')}`);
    out.push(`  ${candidate.file}; own ${JSON.stringify(e.ownLines)}; unique ${JSON.stringify(e.uniqueLines)}; kills ${e.kills}; unique kills ${e.uniqueKills ?? 'n/a'}`);
    if (e.group) out.push(`  group ${e.group.id}: ${e.group.members.join(', ')}`);
    if (e.overlaps.length) out.push(`  overlaps: ${e.overlaps.map((v) => `${v.unit} (${v.sharedLines} lines, ${v.sharedKills} kills${v.coversAllOf ? ', covers all' : ''})`).join('; ')}`);
    if (e.brittle.length) out.push(`  brittle: ${e.brittle.join(', ')}`);
    if (e.pseudoTestedFunctions?.length) out.push(`  pseudo-tested functions: ${e.pseudoTestedFunctions.join(', ')}`);
    if (e.assertions) out.push(`  assertions: ${e.assertions.assertionCount}; unique fingerprints: ${e.assertions.uniqueFingerprints.length}${e.assertions.incomplete ? ' (incomplete)' : ''}`);
  }
  return out;
}

function guard(r, c) {
  const g = r.guard;
  const out = [];
  for (const k of g.checks) {
    const detail = [];
    if (k.base && k.head) detail.push(`${pct(k.base)} -> ${pct(k.head)}`);
    if (k.lost && lostText(k.lost)) detail.push(`lost ${lostText(k.lost)}`);
    if (k.missing) detail.push('head has no mutation data');
    if (k.sources?.length) detail.push(`sources ${k.sources.join(', ')}`);
    if (k.units?.length) detail.push(`units ${k.units.join(', ')} need approval`);
    out.push(`${k.pass ? c.green('pass') : c.red('FAIL')}  ${k.id}${detail.length ? c.dim(`  ${detail.join('; ')}`) : ''}`);
  }
  if (g.removed.length) {
    out.push('', `removed (${g.removed.length})`);
    for (const u of g.removed) {
      out.push(`  ${u.id}${c.dim(`  ${u.tier}, unique lines ${u.uniqueLines ?? 'n/a'}, unique kills ${u.uniqueKills ?? 'n/a'}`)}`);
    }
  }
  out.push('', g.pass ? c.green('guard passed') : c.red('guard failed'));
  return out;
}

const SECTIONS = { report, label, plan, check, guard, review };

/** Formats an engine report for people. */
export function formatReport(command, r, colour) {
  const c = painter(colour);
  const lines = r.suite || r.guard || r.review ? SECTIONS[command](r, c) : [];
  const diags = diagnostics(r, c);
  if (diags.length) lines.push(...(lines.length ? [''] : []), ...diags);
  return lines.length ? `${lines.join('\n')}\n` : '';
}
