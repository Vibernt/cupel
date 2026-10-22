#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
const candidatePath = '/Users/vid/cupel/.scratch/bench/candidates.json';
const percent = (value) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const ms = (value) => value == null ? '—' : `${(value / 1000).toFixed(2)} s`;
const ratio = (value) => value == null ? '—' : `${value.toFixed(2)}×`;
const pct = (value) => value == null ? '—' : `${value.toFixed(2)}%`;
const safe = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const lineCount = (set) => String(set ?? '').split(',').filter(Boolean).reduce((total, span) => {
  const [start, end = start] = span.split('-').map(Number);
  return total + end - start + 1;
}, 0);

export function renderBenchmark(repos, candidates, results) {
  const byName = new Map(candidates.map((c) => [c.repo.split('/').at(-1).toLowerCase(), c]));
  const lines = [
    '# Cupel benchmark: 10 public repositories', '',
    'This document is generated from `bench/results/`. Missing results are shown as pending; no repository commands have been inferred to have passed.', '',
    '## Cross-repository summary', '',
    '| Repository | Size | Agent share | Runner | Baseline median | Cupel collection | Overhead | Critical mutation | Guard replay | Plan replay | Status |',
    '|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const repo of repos) {
    const c = byName.get(repo.name.toLowerCase());
    if (!c) throw new Error(`candidate inventory has no entry for ${repo.name}`);
    const r = results[repo.name] ?? {};
    const guard = r['guard-replay']; const plan = r['plan-replay']; const report = r.report;
    const status = [r.install, r.baseline, report, guard, plan].some((s) => s?.status === 'failed') ? 'failed' :
      report?.status === 'ok' ? `${guard && plan ? 'replays done' : 'report only'}${report.pending?.length ? `; ${report.pending.join(', ')} pending` : ''}` :
      report?.status ?? (r.baseline?.status === 'ok' ? 'baseline only' : r.install?.status === 'ok' ? 'installed only' : 'not run');
    lines.push(`| ${safe(repo.name)} | ${c ? `${(c.sizeKB / 1024).toFixed(1)} MiB` : '—'} | ${c ? percent(c.agentShare) : '—'} | ${repo.runner} | ${ms(r.baseline?.medianMs)} | ${ms(report?.collectionMs)} | ${ratio(report?.overheadRatio)} | ${pct(report?.suite?.criticalMutation?.score)} | ${guard?.outcomes?.length ?? '—'} | ${plan?.outcomes?.length ?? '—'} | ${safe(status)} |`);
  }
  for (const repo of repos) {
    const c = byName.get(repo.name.toLowerCase());
    const r = results[repo.name] ?? {};
    const report = r.report; const baseline = r.baseline;
    lines.push('', `## ${repo.name}`, '',
      `- **Size, language, runner, agent share:** ${c ? `${(c.sizeKB / 1024).toFixed(1)} MiB, ` : 'unknown size, '}${repo.language}, ${repo.runner}, ${c ? percent(c.agentShare) : 'unknown agent share'} (${c?.commitsSampled ?? 'unknown'} sampled commits).`,
      `- **Baseline:** ${ms(baseline?.medianMs)} median of ${baseline?.runs?.length ?? 0} runs; counts ${baseline?.runs?.map((v) => `${v.counts.passed ?? '?'} passed/${v.counts.failed ?? '?'} failed/${v.counts.skipped ?? '?'} skipped`).join(', ') || 'not recorded'}.`,
      `- **Cupel:** collection ${ms(report?.collectionMs)}; two run test-duration sums ${report?.collectionRunDurationSumsMs?.map(ms).join(' / ') ?? '—'}; full report ${ms(report?.wallMs)}; collection overhead ${ratio(report?.overheadRatio)}; peak RSS ${report?.peakKb == null ? 'unavailable' : `${Math.round(report.peakKb / 1024)} MiB`}.`,
      `- **Evidence:** line coverage ${pct(report?.suite?.coverage?.pct)}, critical line coverage ${pct(report?.suite?.criticalCoverage?.pct)}, critical mutation score ${pct(report?.suite?.criticalMutation?.score)}${report?.suite?.criticalMutation ? ` (${report.suite.criticalMutation.detected} detected, ${report.suite.criticalMutation.undetected} undetected)` : ''}.`,
      `- **Advice:** ${report?.rewritePins?.length ?? 0} rewrite pins listed${report?.suite ? ` (${report.suite.advice.rewrite} total)` : ''}; ${report?.groups?.length ?? 0} consolidation groups listed${report?.groupCount != null ? ` (${report.groupCount} total)` : ''}; ${report?.noUniqueEvidenceCount ?? 0} no-unique-evidence hints.`,
      `- **Scope:** ${safe(repo.notes)}`);
    if (report?.topSurvivors?.length) {
      lines.push('', 'Top surviving mutants on critical code:', '', '| File | Line | Operator |', '|---|---:|---|');
      for (const m of report.topSurvivors) lines.push(`| ${safe(m.source)} | ${m.line} | ${safe(m.operator)} |`);
    } else lines.push('', 'Top surviving mutants: unavailable.');
    if (report?.rewritePins?.length) lines.push('', `Rewrite pins: ${report.rewritePins.map((p) => `${safe(p.file)} (${p.brittle.join(', ')})`).join('; ')}.`);
    if (report?.groups?.length) lines.push('', `Consolidation groups: ${report.groups.map((g) => `${safe(g.file)} (${g.units.length} units)`).join('; ')}.`);
    if (report?.noUniqueEvidence?.length) lines.push('', `No-unique-evidence examples: ${report.noUniqueEvidence.map(safe).join('; ')}.`);
    lines.push('', '### Guard replay', '');
    if (r['guard-replay']?.outcomes?.length) {
      lines.push('| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |', '|---|---|---:|---:|---:|');
      for (const o of r['guard-replay'].outcomes) {
        const lost = o.checks.flatMap((v) => Object.values(v.lostLines)).reduce((n, set) => n + lineCount(set), 0);
        const mutants = o.checks.reduce((n, v) => n + v.criticalMutantsLost.length, 0);
        const missing = o.checks.filter((x) => x.missing).map((x) => x.id);
        lines.push(`| ${o.commit.slice(0, 12)} | ${o.pass ? 'pass' : 'FAIL'} (${o.checks.filter((x) => !x.pass).map((x) => x.id).join(', ') || 'all checks'}${missing.length ? `; missing: ${missing.join(', ')}` : ''}) | ${o.removed.length} | ${lost} line references | ${mutants} |`);
      }
    } else lines.push(r['guard-replay']?.status ?? 'Not run.');
    lines.push('', '### Plan replay', '');
    if (r['plan-replay']?.outcomes?.length) {
      lines.push('| Commit | Selected share | Expected / full suite | Touched tests in critical or affected |', '|---|---:|---:|---:|');
      for (const o of r['plan-replay'].outcomes) lines.push(`| ${o.commit.slice(0, 12)} | ${percent(o.selectedShare)} | ${ms(o.expectedMs)} / ${ms(o.fullMs)} | ${o.touched.filter((x) => ['critical', 'affected'].includes(x.bucket)).length}/${o.touched.length} |`);
    } else lines.push(r['plan-replay']?.status ?? 'Not run.');
    const problems = Object.values(r).filter((v) => v?.status === 'failed' || v?.status === 'pending: collector');
    const pending = report?.pending?.map((item) => `report: ${item} pending`) ?? [];
    const unrun = ['install', 'baseline', 'report', 'guard-replay', 'plan-replay'].filter((stage) => !r[stage]);
    lines.push('', `**Pending or failed:** ${Object.keys(r).length === 0 ? 'all stages not run' : [...problems.map((v) => `${v.stage}: ${safe(v.reason ?? v.status)}`), ...pending, ...unrun.map((stage) => `${stage}: not run`)].join('; ') || 'none recorded'}.`);
  }
  lines.push('', '## Method and caveats', '',
    '- `install` and the install substeps of guard replay are the sole network-enabled Docker operations. The first install hydrates missing Git blobs from the public remote and verifies the object set. Baselines run three times with `--network none`; report collection uses two runs. Each candidate has a separate Docker cache volume and only its repository and read-only Cupel tree mounted.',
    '- Guard replay selects the five newest non-merge commits that changed tests. Each parent and head is archived inside a container, installed, collected and compared. Plan replay uses the ten newest source-changing non-merge commits with their exact zero-context diff line sets against the report input.',
    '- The plain baseline and Cupel collection may have different instrumentation and file scope; the overhead ratio is collection wall time divided by median plain wall time. Full report wall time includes mutation and is listed separately. Expected plan time is the sum of observed unit durations, not a measured shortened run.',
    '- Mutation is capped at 300 mutants and 1,200 seconds per collection. A score from a capped sample is not whole-code mutation coverage. Current Cupel mutates only runtime `node`; Python and forthcoming Vitest collection have no mutation evidence unless Cupel adds support. Missing mutation remains unavailable, not zero.',
    '- The ten displayed critical survivors are ordered by file and line, not by severity. A no-mutation report with `--runs 2` measures collection plus Cupel grading, so its wall time is an upper bound on collector time. The two run duration sums add each test\'s duration and are not wall time when tests run in parallel.',
    '- Go, Rust, .NET and Ruby have no Cupel collector in this build. Their baseline is measured but Cupel report and replays remain `pending: collector`. Any install, baseline or collection failure is recorded as a failure without substitute commands.',
    '- Agent share and size come from the candidate inventory, not from these benchmark runs. Agent share measures commit trailers and bot authors in a recent window; it does not prove the authorship of every test.',
    '- Docker, registry access, install scripts, candidate tests, git archive replay and real benchmark timing were not run while building this harness. The orchestrator must run them on Colima linux/arm64 and inspect each stage JSON.',
    '',
    'Cleanup after review: remove each candidate’s `.cupel-bench.json`, `.cupel/`, `.cupel-bench-replay-*` and `.cupel-bench-changed-lines.json`; remove `bench/results/<name>/` and named `cupel-bench-<name>-cache` Docker volumes when measurements are no longer needed. `bench/results/.gitkeep` is committed; result JSON stays ignored.', '');
  return lines.join('\n');
}

export function readResults(repos, resultsDir) {
  const out = {};
  for (const repo of repos) {
    out[repo.name] = {};
    for (const stage of ['install', 'baseline', 'report', 'guard-replay', 'plan-replay']) {
      const path = join(resultsDir, repo.name, `${stage}.json`);
      if (existsSync(path)) out[repo.name][stage] = JSON.parse(readFileSync(path, 'utf8'));
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repos = JSON.parse(readFileSync(join(here, 'repos.json'), 'utf8'));
  const candidates = JSON.parse(readFileSync(candidatePath, 'utf8'));
  writeFileSync(join(here, 'BENCHMARK.md'), renderBenchmark(repos, candidates, readResults(repos, join(here, 'results'))) + '\n');
}
