#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditComparison } from './evidence.mjs';
import { renderDetails } from './report-details.mjs';

const here = import.meta.dirname;
const candidatePath = '/Users/vid/cupel/.scratch/bench/candidates.json';
const stages = ['install', 'baseline', 'report', 'guard-replay', 'plan-replay', 'all'];
const safe = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const ms = (value) => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : '—';
const pct = (value) => Number.isFinite(value) ? `${value.toFixed(2)}%` : '—';
const share = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const ratio = (value) => Number.isFinite(value) ? `${value.toFixed(2)}×` : '—';
const count = (mutation, status) => mutation ? mutation.counts[status] : '—';

export function renderBenchmark(repos, candidates, results) {
  const byName = new Map(candidates.map((candidate) => [candidate.repo.split('/').at(-1).toLowerCase(), candidate]));
  const lines = [
    '# Cupel benchmark: 10 public repositories', '',
    'Generated from saved `bench/results/` artifacts. Historical timings remain raw measurements. Overhead is shown only after matching runner sets, test IDs, revision, Cupel, configuration and runtime provenance are verified. A test count alone does not prove test identity.', '',
    '## Cross-repository summary', '',
    '| Repository | Size | Agent share | Runner | Baseline median | Collection | Full report | Verified overhead | Comparison | Critical score | Killed | Timeout | Survived | No coverage | Error | Guard | Plan |',
    '|---|---:|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|---|',
  ];
  for (const repo of repos) {
    const candidate = byName.get(repo.name.toLowerCase());
    if (!candidate) throw new Error(`candidate inventory has no entry for ${repo.name}`);
    const r = results[repo.name] ?? {};
    const baseline = r.baseline; const report = r.report;
    const audit = auditComparison(baseline, report);
    const mutation = report?.status === 'ok' ? report.mutationEvidence : null;
    const overhead = audit.verdict === 'verified' && baseline.medianMs > 0 ? report.collectionMs / baseline.medianMs : null;
    const score = report?.suite?.criticalMutation;
    const scoreLabel = report?.status !== 'ok' ? '—' : score?.score == null && score?.detected === 0 && score?.undetected === 0 ? 'empty' : pct(score?.score);
    lines.push(`| ${safe(repo.name)} | ${(candidate.sizeKB / 1024).toFixed(1)} MiB | ${share(candidate.agentShare)} | ${safe(repo.runner)} | ${ms(baseline?.status === 'ok' ? baseline.medianMs : null)} | ${ms(report?.collectionMs)} | ${ms(report?.wallMs)} | ${ratio(overhead)} | ${audit.verdict} | ${scoreLabel} | ${count(mutation, 'killed')} | ${count(mutation, 'timeout')} | ${count(mutation, 'survived')} | ${count(mutation, 'no-coverage')} | ${count(mutation, 'error')} | ${r['guard-replay']?.status ?? 'not run'} | ${r['plan-replay']?.status ?? 'not run'} |`);
  }
  for (const repo of repos) {
    const candidate = byName.get(repo.name.toLowerCase());
    lines.push(...renderDetails(repo, candidate, results[repo.name] ?? {}, auditComparison, { safe, ms, pct, share, ratio, stages }));
  }
  lines.push('', '## Method and limits', '',
    '- Saved historical baseline and report stages do not contain revision, Cupel, config, runtime or exact test-ID provenance. Their ratios cannot be verified retrospectively. Count mismatches make Go and Zotero comparisons invalid. Raw wall times are retained.',
    '- A report can cover multiple runners while the plain baseline command runs only one. Future measurements record the report runner inventory, but baseline runner IDs or sets must come from actual runner output; a configured runner name is not evidence that it executed.',
    '- Full report time includes mutation; collection time is a separate no-mutation report with two test runs. Cold and warm sums add individual test durations and are not wall time when tests run in parallel.',
    '- Historical plan replays saved full plan estimates but not selected-duration estimates. The selected estimate is unavailable for those outcomes; no speedup follows from selected share.',
    '- Empty mutation evidence and unavailable mutation evidence are distinct. Scores from capped mutation samples do not describe whole-code mutation coverage. Retained candidate input files are not read by this report generator.',
    '- Candidate size and agent share come from the candidate inventory, not these benchmark stages. Failed and missing stages remain visible; full error text is in the saved stage JSON.',
    '- `all.json` records a separate all-stage invocation. Later individual-stage successes do not erase its earlier failure.', '');
  return lines.join('\n');
}

export function readResults(repos, resultsDir) {
  const out = {};
  for (const repo of repos) {
    out[repo.name] = {};
    for (const stage of stages) {
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
