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
  const left = s.unmeasured ? `, ${s.unmeasured} ${s.unmeasured === 1 ? 'source' : 'sources'} not measured` : '';
  return `${s.tests} tests, ${s.units} units, coverage ${pct(s.coverage)} (${s.coverage.covered}/${s.coverage.coverable})${left}, mutation score ${score(s.mutation)}`;
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
    if (k.units?.length) detail.push(k.id === 'head-passes' ? `units ${k.units.join(', ')} newly fail` : `units ${k.units.join(', ')} need approval`);
    if (k.notCompared) { out.push(`${c.dim('not compared')}  ${k.id}${c.dim('  runtime changed; line sets differ between runtimes')}`); continue; }
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

const REASON_TEXT = {
  fails: 'fails', skipped: 'skipped', flaky: 'passes and fails across runs', 'no-assertion': 'checks nothing',
  tautology: 'has an assertion that cannot fail', 'catches-nothing': 'runs code with faults but catches none',
  'catches-only-by-panic': 'catches faults only because the code crashed, not by checking',
};
const reasonText = (r) => REASON_TEXT[r] ?? (r.startsWith('pinned:') ? `pins ${r.slice(7)}` : r);

/** The audit as Markdown: one heading per question. */
function audit(r) {
  const a = r.audit;
  const out = ['# Test-quality audit', '', a.notice, ''];
  out.push('## 1. Possibly wrong tests', '');
  if (!a.wrong.length) out.push('None found.');
  for (const w of a.wrong) out.push(`- \`${w.unit}\`: ${w.reasons.map(reasonText).join('; ')}`);
  out.push('', 'Whether an expected value is right needs a person or reviewer: run `cupel review` for the evidence.', '');
  out.push('## 2. Tests that catch no faults', '');
  const f = a.falseTests;
  if (!f.measured) out.push('Not measured: collect with mutation to answer this.');
  else {
    if (!f.units.length) out.push('No targeted test runs faulty code without catching it.');
    for (const u of f.units) out.push(`- \`${u.unit}\`: ${reasonText(u.reason)} (covers ${u.coveredMutants} faults, catches ${u.kills}${u.panicKills ? `, ${u.panicKills} only by crash` : ''})`);
    if (f.unchecked.length) {
      out.push('', 'Code that runs but where a fault went unnoticed:');
      for (const s of f.unchecked) {
        out.push(`- \`${s.source}\` lines ${s.lines}`);
        for (const m of s.mutants) out.push(`  - line ${m.line}: ${m.description ?? m.id}`);
      }
    }
    if (f.timeoutOnly.length) out.push('', `Faults detected only by a timeout (no test credited): ${f.timeoutOnly.length}.`);
  }
  out.push('', '## 3. Tests that protect the same thing', '');
  if (!a.overlap.length) out.push('None found.');
  for (const g of a.overlap) out.push(`- ${g.units.map((u) => `\`${u}\``).join(', ')}: same ${g.basis === 'kills' ? 'caught faults' : 'lines'}${g.crossRunner ? ' (across languages)' : ''}`);
  out.push('', 'Overlap is evidence, not proof that a test is redundant: read the assertions first.', '');
  out.push('## 4. Tests that could be combined', '');
  const FORM = { 'table-of-cases': 'one test with a table of cases', parametrize: 'one parametrized test (pytest.mark.parametrize)', each: 'one test.each or a loop over cases', 'shared-helper': 'a shared helper or fixture' };
  if (!a.combine.groups.length && !a.combine.acrossFiles.length) out.push('None found.');
  for (const g of a.combine.groups) out.push(`- \`${g.file}\`: ${g.units.map((u) => `\`${u}\``).join(', ')} as ${FORM[g.form]}`);
  for (const g of a.combine.acrossFiles) out.push(`- across ${g.files.map((x) => `\`${x}\``).join(', ')}: ${g.units.map((u) => `\`${u}\``).join(', ')} through ${FORM[g.form]}`);
  out.push('', '## 5. Coverage', '');
  const files = a.coverage.files;
  const covered = files.reduce((n, x) => n + x.covered, 0); const coverable = files.reduce((n, x) => n + x.coverable, 0);
  const left = a.coverage.unmeasured.length;
  out.push(`${covered} of ${coverable} lines covered${coverable ? ` (${Math.floor((10000 * covered) / coverable) / 100}%)` : ''}${left ? `; ${left} ${left === 1 ? 'source' : 'sources'} not measured, listed below` : ''}.`, '');
  const gaps = files.filter((x) => x.uncovered).sort((x, y) => Number(y.critical) - Number(x.critical) || (y.coverable - y.covered) - (x.coverable - x.covered));
  if (gaps.length) {
    out.push('| File | Covered | Uncovered lines |', '| --- | --- | --- |');
    for (const x of gaps) out.push(`| \`${x.source}\`${x.critical ? ' (critical)' : ''} | ${x.covered}/${x.coverable} | ${x.uncovered} |`);
  }
  if (a.coverage.unmeasured.length) {
    out.push('', 'Not measured (never counted as uncovered):');
    for (const u of a.coverage.unmeasured) out.push(`- \`${u.source}\`: ${u.reason}`);
  }
  out.push('', '## 6. Faster and leaner suite', '');
  const sp = a.speed;
  if (sp.slowest.length) { out.push('Slowest tests:'); for (const x of sp.slowest) out.push(`- \`${x.unit}\`: ${x.durationMs} ms`); }
  if (sp.slowLowValue.length) out.push('', `Slow and little unique evidence: ${sp.slowLowValue.map((u) => `\`${u}\``).join(', ')}.`);
  if (sp.flaky.length) out.push('', `Flaky, costing reruns: ${sp.flaky.map((u) => `\`${u}\``).join(', ')}.`);
  if (sp.mutationCostMs !== null) out.push('', `Fault testing these faults takes about ${Math.round(sp.mutationCostMs / 1000)} s of test time; changed-lines mode runs only the faults a change touches.`);
  out.push('', 'Merging look-alike tests (section 4) reduces the test count while keeping every case; any change must pass `cupel guard`.');
  return out;
}

const SECTIONS = { report, label, plan, check, guard, review, audit };

/** Formats an engine report for people. */
export function formatReport(command, r, colour) {
  const c = painter(colour);
  const lines = r.suite || r.guard || r.review || r.audit ? SECTIONS[command](r, c) : [];
  const diags = diagnostics(r, c);
  if (diags.length) lines.push(...(lines.length ? [''] : []), ...diags);
  return lines.length ? `${lines.join('\n')}\n` : '';
}
