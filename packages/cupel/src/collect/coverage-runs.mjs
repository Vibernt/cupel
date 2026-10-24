// Combine per-run source-line maps while retaining variation within each test or setup bucket.
import { unionLines, formatLines } from './node/lines.mjs';

export function mergeLines(into, from) {
  for (const [source, lines] of from ?? []) into.set(source, unionLines(into.get(source) ?? [], lines));
  return into;
}

export function foldRuns(runs, unstable) {
  const combined = new Map();
  if (!runs.length) return combined;
  for (const run of runs) mergeLines(combined, run);
  if (runs.length > 1) {
    for (const [source, lines] of combined) {
      const varying = lines.filter((line) => runs.some((run) => !(run?.get(source) ?? []).includes(line)));
      if (varying.length) unstable.set(source, unionLines(unstable.get(source) ?? [], varying));
    }
  }
  return combined;
}

export function unstableObject(unstable) {
  return Object.fromEntries([...unstable].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([source, lines]) => [source, formatLines(lines)]));
}
