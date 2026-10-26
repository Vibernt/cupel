const lineCount = (set) => String(set ?? '').split(',').filter(Boolean).reduce((total, span) => {
  const [start, end = start] = span.split('-').map(Number);
  return total + end - start + 1;
}, 0);

function reason(value, safe) {
  const text = String(value ?? 'no reason recorded');
  return safe(text.length <= 500 ? text : `${text.slice(0, 240)} … ${text.slice(-220)} [full reason in stage JSON]`);
}

function replays(lines, results, { safe, ms, share }) {
  const guard = results['guard-replay'];
  lines.push('', '### Guard replay', '');
  if (guard?.status === 'ok' && guard.outcomes?.length) {
    lines.push('| Commit | Verdict | Removed units | Lost lines | Critical mutants lost |', '|---|---|---:|---:|---:|');
    for (const outcome of guard.outcomes) {
      const checks = outcome.checks ?? [];
      const lost = checks.flatMap((check) => Object.values(check.lostLines ?? {})).reduce((n, set) => n + lineCount(set), 0);
      const mutants = checks.reduce((n, check) => n + (check.criticalMutantsLost?.length ?? 0), 0);
      const failed = checks.filter((check) => !check.pass).map((check) => check.id);
      lines.push(`| ${outcome.commit.slice(0, 12)} | ${outcome.pass ? 'pass' : 'FAIL'} (${safe(failed.join(', ') || 'all checks')}) | ${outcome.removed?.length ?? 0} | ${lost} | ${mutants} |`);
    }
  } else lines.push(safe(guard?.status ?? 'Not run.'));
  const plan = results['plan-replay'];
  lines.push('', '### Plan replay', '');
  if (plan?.status === 'ok' && plan.outcomes?.length) {
    lines.push('| Commit | Selected share | Selected duration estimate | Full plan estimate | Touched tests in critical or affected |', '|---|---:|---:|---:|---:|');
    for (const outcome of plan.outcomes) lines.push(`| ${outcome.commit.slice(0, 12)} | ${share(outcome.selectedShare)} | ${ms(outcome.selectedDurationMs)} | ${ms(outcome.expectedMs)} | ${(outcome.touched ?? []).filter((test) => ['critical', 'affected'].includes(test.bucket)).length}/${outcome.touched?.length ?? 0} |`);
  } else lines.push(safe(plan?.status ?? 'Not run.'));
}

export function renderDetails(repo, candidate, results, auditComparison, fmt) {
  const { safe, ms, pct, share, ratio, stages } = fmt;
  const baseline = results.baseline; const report = results.report;
  const audit = auditComparison(baseline, report);
  const mutation = report?.status === 'ok' ? report.mutationEvidence : null;
  const counts = baseline?.runs?.map((run) => `${run.counts?.passed ?? '?'} passed/${run.counts?.failed ?? '?'} failed/${run.counts?.skipped ?? '?'} skipped`).join(', ') || 'not recorded';
  const score = report?.suite?.criticalMutation;
  const mutationScore = score?.score != null ? `${pct(score.score)} (${score.detected ?? '?'} detected, ${score.undetected ?? '?'} undetected)` :
    score?.detected === 0 && score?.undetected === 0 ? 'empty scored sample (0 detected, 0 undetected)' : 'unavailable';
  const failedWithoutNames = baseline?.runs?.some((run) => run.counts?.failed > 0) && !baseline.failingTests?.length;
  const lines = ['', `## ${repo.name}`, '',
    `- **Size and scope:** ${(candidate.sizeKB / 1024).toFixed(1)} MiB; ${repo.language}; ${repo.runner}; agent share ${share(candidate.agentShare)} across ${candidate.commitsSampled ?? 'unknown'} sampled commits. ${safe(repo.notes)}`,
    `- **Baseline:** ${baseline?.status === 'ok' ? `${ms(baseline.medianMs)} median of ${baseline.runs?.length ?? 0} runs` : baseline ? `failed after ${baseline.runs?.length ?? 0} attempt(s)` : 'not run'}; ${counts}.`,
    `- **Collection:** ${ms(report?.collectionMs)} wall; cold/warm test-duration sums ${report?.collectionRunDurationSumsMs?.map(ms).join(' / ') ?? '—'}; full report ${ms(report?.wallMs)} wall. These are separate measurements.`,
    `- **Comparison:** ${audit.verdict}; ${audit.reasons.length ? audit.reasons.map(safe).join('; ') : 'matching provenance and inventories'}. ${audit.verdict === 'verified' && baseline.medianMs > 0 ? `Collection/baseline ratio ${ratio(report.collectionMs / baseline.medianMs)}.` : 'No overhead ratio is claimed.'}`,
    `- **Collected inventory:** ${report?.collectionInventory ? `${report.collectionInventory.count} IDs, SHA-256 ${report.collectionInventory.idHash}, runners ${safe(JSON.stringify(report.collectionInventory.runners))}` : `${report?.collectedTests ?? 'unavailable'} tests; exact ID inventory unavailable`}.`,
    `- **Evidence:** line coverage ${pct(report?.suite?.coverage?.pct)}; critical line coverage ${pct(report?.suite?.criticalCoverage?.pct)}; critical mutation score ${mutationScore}.`,
    `- **Critical mutant statuses:** ${mutation ? `${mutation.counts.killed} killed; ${mutation.counts.timeout} timeout; ${mutation.counts.survived} survived; ${mutation.counts['no-coverage']} no coverage; ${mutation.counts.error} error` : 'unavailable from saved report stage'}.`,
    `- **Environment failures:** ${baseline?.failingTests?.length ? `${baseline.failingTests.map(safe).join(', ')}; repeated on check: ${baseline.flakyCheck?.repeatedFailures?.map(safe).join(', ') || 'not checked'}` : failedWithoutNames ? `${baseline.runs.map((run) => run.counts.failed).join('/')} failed per run; names unavailable` : baseline?.status === 'failed' ? 'baseline failed before named test results' : baseline ? 'none recorded' : repo.firstRunEnvironmentFailure ? safe(repo.firstRunEnvironmentFailure) : 'not measured'}.`,
    `- **Advice:** ${report?.rewritePins?.length ?? 0} recorded rewrite pins; ${report?.groups?.length ?? 0} recorded consolidation groups; ${report?.noUniqueEvidenceCount ?? 0} no-unique-evidence hints.`];
  const survivors = mutation?.survivors ?? (report?.status === 'ok' ? report.topSurvivors : null);
  if (survivors?.length) {
    lines.push('', `Recorded top surviving mutants${mutation ? '' : ' (total statuses unavailable)'}:`, '', '| File | Line | Operator |', '|---|---:|---|');
    for (const mutant of survivors) lines.push(`| ${safe(mutant.source)} | ${mutant.line} | ${safe(mutant.operator)} |`);
  }
  replays(lines, results, fmt);
  lines.push('', '**Stage status and reasons:**', '');
  for (const stage of stages) {
    const value = results[stage];
    lines.push(`- ${stage}: ${safe(value?.status ?? 'not run')}${value?.status && value.status !== 'ok' ? ` — ${reason(value.reason, safe)}` : ''}.`);
  }
  return lines;
}
