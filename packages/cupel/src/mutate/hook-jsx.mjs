// The innermost module load hook for JSX mutants, registered with `module.register` by hook.mjs before the
// project's own loader (for example `--import tsx`) registers its hooks. Async hooks run last-registered first, so
// the project's loader calls this hook through `nextLoad` and transforms the mutated text it gets back: the fault
// is in the code the loader produces, exactly as the file would be if it held the fault. Without a mutant (`data`
// null, in baselines) it passes everything through, so baselines run under the same hooks as mutants.

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
