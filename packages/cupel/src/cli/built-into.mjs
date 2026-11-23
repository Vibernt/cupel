// Code built into an artifact that another language's tests run (test-quality
// audit, phase 7). `cupel.json` names it: { "builtInto": { "<source glob>":
// "<artifact path>" } }, for example Rust crates compiled to a WebAssembly
// module that JavaScript tests load in workerd. A matching source that no test
// of its own language covers is reported as `unmeasured`, with the artifact and
// how many tests loaded it (tests' `loads`), instead of looking untested.
import { anyGlobMatches } from '../engine/match.mjs';
import { mergeRunners, runnerParts } from './merge-runners.mjs';

const covers = (input, source) => Object.values(input.coverage?.byTest ?? {}).some((row) => (row[source] ?? '') !== '')
  || Object.values(input.coverage?.byFile ?? {}).some((row) => (row[source] ?? '') !== '')
  || Object.values(input.coverage?.setup ?? {}).some((row) => (row[source] ?? '') !== '');

function label(input, rules, loaders) {
  let changed = false;
  const sources = { ...input.sources };
  for (const [source, entry] of Object.entries(sources)) {
    if (entry.unmeasured !== undefined || !entry.coverable) continue;
    const artifact = Object.entries(rules).find(([glob]) => anyGlobMatches([glob], source))?.[1];
    if (!artifact || covers(input, source)) continue;
    const n = loaders.get(artifact) ?? 0;
    sources[source] = { ...entry, coverable: '', unmeasured: n
      ? `built into ${artifact}, which ${n} test${n === 1 ? '' : 's'} load; lines inside WebAssembly are not measured`
      : `built into ${artifact}; no measured test loads it` };
    changed = true;
  }
  if (!changed) return input;
  const unstable = Object.fromEntries(Object.entries(input.coverage?.unstable ?? {}).filter(([source]) => sources[source].unmeasured === undefined));
  return { ...input, sources, ...(input.coverage?.unstable ? { coverage: { ...input.coverage, unstable } } : {}) };
}

/** Applies `cfg.builtInto` to a collected input, keeping runner parts consistent. */
export function applyBuiltInto(input, cfg) {
  const rules = cfg.builtInto ?? {};
  if (!Object.keys(rules).length) return input;
  const parts = runnerParts(input);
  const all = parts ? parts.flatMap((p) => p.input.tests) : input.tests;
  const loaders = new Map();
  for (const t of all) for (const artifact of t.loads ?? []) loaders.set(artifact, (loaders.get(artifact) ?? 0) + 1);
  if (!parts) return label(input, rules, loaders);
  const next = parts.map((p) => ({ name: p.name, input: label(p.input, rules, loaders) }));
  return next.every((p, i) => p.input === parts[i].input) ? input : mergeRunners(next);
}
