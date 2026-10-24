// K14: combine independently collected runner inputs without changing the collectors.
import { environment } from './errors.mjs';
import { lines, union, format } from '../engine/lines.mjs';

const lineUnion = (a = '', b = '') => format(union(lines(a), lines(b)));
const collectedParts = new WeakMap();
export const runnerParts = (input) => collectedParts.get(input);
export function inheritRunnerParts(from, to) {
  const parts = collectedParts.get(from);
  if (parts) collectedParts.set(to, parts);
  return to;
}

/** Reconstruct a runner's evidence when the merged input came from --input. */
export function splitRunnerInput(input) {
  const stored = collectedParts.get(input);
  if (stored) return stored;
  if (!input.runtimes) return [{ name: null, input }];
  return input.runtimes.map((runtime) => {
    const tests = input.tests.filter((test) => test.runner === runtime.runner);
    const ids = new Set(tests.map((test) => test.id));
    const units = new Set(tests.map((test) => test.unit ?? test.id));
    const files = new Set(tests.map((test) => test.file));
    const choose = (value, allowed) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => allowed.has(key)));
    const byTest = choose(input.coverage.byTest, ids);
    const byFile = choose(input.coverage.byFile, files);
    const setup = choose(input.coverage.setup, files);
    const sourcePaths = new Set([
      ...Object.values(byTest).flatMap(Object.keys),
      ...Object.values(byFile).flatMap(Object.keys),
      ...Object.values(setup).flatMap(Object.keys),
    ]);
    const sourceExt = runtime.name === 'node' ? /\.[cm]?[jt]sx?$/ : runtime.name === 'python' ? /\.py$/ : runtime.name === 'go' ? /\.go$/ : runtime.name === 'rust' ? /\.rs$/ : /\.rb$/;
    for (const path of Object.keys(input.sources)) if (sourceExt.test(path)) sourcePaths.add(path);
    const mutants = (input.mutation?.mutants ?? []).filter((m) => sourcePaths.has(m.source));
    const part = {
      spec: input.spec, kind: 'input', runtime: { name: runtime.name, version: runtime.version },
      sources: choose(input.sources, sourcePaths), tests: tests.map(({ runner, ...test }) => test),
      coverage: { granularity: input.coverage.granularity, byTest, ...(input.coverage.byFile ? { byFile } : {}), setup,
        rechecked: (input.coverage.rechecked ?? []).filter((id) => units.has(id)),
        unstable: choose(input.coverage.unstable, sourcePaths) },
    };
    if (input.mutation) part.mutation = { mutants, targeted: (input.mutation.targeted ?? []).filter((id) => units.has(id)) };
    if (input.brittleness) part.brittleness = input.brittleness.filter((b) => ids.has(b.test));
    if (input.shapes) part.shapes = choose(input.shapes, units);
    return { name: runtime.runner, input: part };
  });
}

function mergeLineMap(into, from) {
  for (const [source, set] of Object.entries(from ?? {})) {
    into[source] = lineUnion(into[source], set);
  }
}

function mergeNested(into, from) {
  for (const [owner, entry] of Object.entries(from ?? {})) {
    if (!into[owner]) into[owner] = {};
    mergeLineMap(into[owner], entry);
  }
}

export function mergeRunners(parts) {
  if (!parts.length) throw environment('no runners were selected');
  if (parts.length === 1) return parts[0].input;
  const [first] = parts;
  const merged = {
    spec: first.input.spec, kind: 'input', runtime: first.input.runtime,
    runtimes: [], sources: {}, tests: [],
    coverage: { granularity: first.input.coverage.granularity, byTest: {}, setup: {}, rechecked: [], unstable: {} },
  };
  const tests = new Set(), mutants = new Set();
  for (const { name, input } of parts) {
    if (input.spec !== merged.spec || input.kind !== 'input' || !input.runtime?.name || !input.runtime?.version) {
      throw environment(`runner ${name} returned an invalid input header`);
    }
    merged.runtimes.push({ runner: name, ...input.runtime });
    for (const [path, source] of Object.entries(input.sources ?? {})) {
      const old = merged.sources[path];
      if (old && old.hash !== source.hash) throw environment(`runners disagree on source hash: ${path}`);
      merged.sources[path] = old ? { ...old, coverable: lineUnion(old.coverable, source.coverable) } : { ...source };
    }
    for (const test of input.tests ?? []) {
      if (tests.has(test.id)) throw environment(`duplicate test id across runners: ${test.id}`);
      tests.add(test.id);
      merged.tests.push({ ...test, runner: name });
    }
    const cov = input.coverage ?? {};
    if (cov.granularity !== first.input.coverage.granularity) {
      throw environment(`runner ${name} has ${cov.granularity} coverage, but ${first.name} has ${first.input.coverage.granularity}; the input format cannot represent both granularities`);
    }
    mergeNested(merged.coverage.byTest, cov.byTest);
    if (cov.byFile) {
      merged.coverage.byFile ??= {};
      mergeNested(merged.coverage.byFile, cov.byFile);
    }
    mergeNested(merged.coverage.setup, cov.setup);
    merged.coverage.rechecked.push(...(cov.rechecked ?? []));
    mergeLineMap(merged.coverage.unstable, cov.unstable);
    if (input.mutation) {
      merged.mutation ??= { mutants: [], targeted: [] };
      for (const mutant of input.mutation.mutants) {
        if (mutants.has(mutant.id)) throw environment(`duplicate mutant id across runners: ${mutant.id}`);
        mutants.add(mutant.id);
        merged.mutation.mutants.push(mutant);
      }
      merged.mutation.targeted.push(...(input.mutation.targeted ?? []));
    }
    if (input.brittleness) (merged.brittleness ??= []).push(...input.brittleness);
    if (input.shapes) {
      merged.shapes ??= {};
      for (const [unit, shape] of Object.entries(input.shapes)) {
        merged.shapes[unit] = [...new Set([...(merged.shapes[unit] ?? []), ...shape])].sort((a, b) => a - b);
      }
    }
  }
  collectedParts.set(merged, parts);
  return merged;
}
