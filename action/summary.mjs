// Render only bounded, escaped guard data. Never put test output or arbitrary CLI text in a job summary.
const LIMIT = 3500;
const clean = (value, limit = 120) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const cell = (value) => clean(value).replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function summary(report, exit) {
  const label = ['passed', 'guard failed', 'invalid input', 'environment error'][exit] ?? 'environment error';
  const lines = [`## Cupel guard: ${label}`, '', `Exit code: ${exit}.`];
  const checks = report?.guard?.checks;
  if (Array.isArray(checks)) {
    lines.push('', '| Check | Result |', '| --- | --- |');
    for (const check of checks.slice(0, 7)) lines.push(`| ${cell(check.id ?? check.name)} | ${check.pass === true ? 'pass' : 'fail'} |`);
  }
  const diagnostics = report?.diagnostics;
  if (Array.isArray(diagnostics) && diagnostics.length) {
    lines.push('', 'Diagnostics:');
    for (const d of diagnostics.slice(0, 3)) lines.push(`- ${cell(d.code)}: ${cell(d.message, 180)}`);
  }
  return `${lines.join('\n').slice(0, LIMIT)}\n`;
}
