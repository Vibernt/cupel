import { positiveIntervals } from '../node/intervals.mjs';
import { sourceMapLines } from '../vitest/sources.mjs';
import { mergeLines, foldRuns, unstableObject } from '../coverage-runs.mjs';
import { formatLines } from '../node/lines.mjs';
import { JestCollectorError } from './process.mjs';

function mapped(root, suite, entry, sources) {
  const script = suite.scripts?.[entry.scriptId];
  if (!script || typeof script.source !== 'string') throw new JestCollectorError(`Jest script source missing for ${entry.scriptId}`);
  const intervals = positiveIntervals(entry.functions);
  const diagnostics = [];
  const result = sourceMapLines(root, script, intervals, sources, () => {}, diagnostics);
  if (diagnostics.length || (intervals.length && !result))
    throw new JestCollectorError(`Jest source mapping failed for ${script.url}: ${diagnostics.map(d => d.message ?? d.code).join(', ')}`);
  return result;
}

export function coverageOfSuite(root, suite, sources) {
  const setup = new Map();
  const byTest = new Map(suite.tests.map(t => [t.id, new Map()]));
  if (!Array.isArray(suite.snapshots) || !suite.snapshots.length) throw new JestCollectorError(`Jest coverage snapshots missing for ${suite.file}`);
  for (const snapshot of suite.snapshots) {
    if (!Array.isArray(snapshot.active) || !Array.isArray(snapshot.entries)) throw new JestCollectorError(`malformed Jest coverage for ${suite.file}`);
    for (const entry of snapshot.entries) {
      const result = mapped(root, suite, entry, sources);
      if (!result) continue;
      const [source, lines] = result;
      if (!snapshot.active.length) mergeLines(setup, new Map([[source, lines]]));
      else for (const id of snapshot.active) {
        const target = byTest.get(id);
        if (!target) throw new JestCollectorError(`unknown active Jest test ${id}`);
        mergeLines(target, new Map([[source, lines]]));
      }
    }
  }
  return { setup, byTest };
}

export function combineJestCoverage(runs, sources) {
  const unstable = new Map();
  const ids = runs[0].tests.map(t => t.id);
  const byTest = Object.fromEntries(ids.map(id => [id, linesObject(foldRuns(runs.map(r => r.coverage.byTest.get(id)), unstable))]));
  const files = [...new Set(runs[0].suites.map(s => s.file))];
  const setup = Object.fromEntries(files.map(file => [file, linesObject(foldRuns(runs.map(r => r.coverage.setup.get(file)), unstable))]));
  return { granularity:'test', byTest, setup,
    ...(runs.length > 1 ? { unstable:unstableObject(unstable) } : {}) };
}

export const linesObject = map => Object.fromEntries([...map].sort(([a],[b]) => a.localeCompare(b)).map(([file, lines]) => [file, formatLines(lines)]));
