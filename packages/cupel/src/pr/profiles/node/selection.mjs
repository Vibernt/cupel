import { parse } from '../../../engine/lines.mjs';
import { cmp } from '../../../engine/order.mjs';

const hasLine = (value, line) => {
  if (value === undefined) return false;
  const parsed = parse(value);
  if (parsed.malformed || parsed.bad.length) throw new Error('Node PR mutation coverage line set is malformed');
  return parsed.set.some(([first, last]) => first <= line && line <= last);
};

/** Every file with passed per-test or setup ownership of one source line. */
export function profileMutationFiles(input, source, line) {
  if (input?.coverage?.granularity !== 'test' || !input.coverage.byTest ||
      !input.coverage.setup || !Number.isSafeInteger(line) || line < 1)
    throw new Error('Node PR mutation requires verified per-test and setup coverage');
  if (hasLine(input.coverage.unstable?.[source], line))
    throw new Error(`Node PR mutant line has unstable coverage: ${source}:${line}`);
  const files = new Set();
  for (const row of input.tests) {
    if (row.status !== 'passed') continue;
    if (hasLine(input.coverage.byTest[row.id]?.[source], line)) files.add(row.file);
  }
  for (const [file, evidence] of Object.entries(input.coverage.setup)) {
    if (hasLine(evidence[source], line) && input.tests.some(row =>
        row.file === file && row.status === 'passed')) files.add(file);
  }
  return [...files].sort(cmp);
}
