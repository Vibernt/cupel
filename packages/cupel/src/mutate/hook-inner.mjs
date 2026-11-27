// The innermost module load hook for marked mutants. hook.mjs registers it with `module.register` just before the
// project's own first `module.register` call (for example tsx's), so the project's async loader runs first, calls
// this hook through `nextLoad`, and transforms the mutated text it gets back: the fault is in the code the loader
// produces, exactly as the file would be if it held the fault. Without a marked mutant (`data` null, in baselines and
// for unmarked faults) it passes everything through.

import { readFileSync } from 'node:fs';

let spec = null;

export function initialize(data) {
  spec = data ?? null;
}

export async function load(url, context, nextLoad) {
  if (!spec || url.split('?')[0].split('#')[0] !== spec.url) return nextLoad(url, context);
  const original = await nextLoad(url, context);
  return { ...original, source: readFileSync(spec.sourcePath, 'utf8'), shortCircuit: true };
}
