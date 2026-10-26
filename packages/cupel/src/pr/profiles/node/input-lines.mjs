import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globMatches } from '../../../engine/match.mjs';
import { cmp } from '../../../engine/order.mjs';
import { analyse, coveredLines, formatLines } from '../../../collect/node/lines.mjs';
import { foldRuns, unstableObject } from '../../../collect/coverage-runs.mjs';

const SOURCE_EXT = /\.(mjs|cjs|js|mts|cts|ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__test__']);
const sortedObject = entries => Object.fromEntries([...entries].sort((a, b) => cmp(a[0], b[0])));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Construct line facts only from the freshly validated request manifest. */
export function profileSources(root, manifest, testFiles, scope = {}) {
  const include = scope.include ?? ['**'];
  const exclude = scope.exclude ?? [];
  const sources = new Map();
  for (const file of Object.keys(manifest).sort(cmp)) {
    if (!SOURCE_EXT.test(file) || TEST_FILE.test(file) || testFiles.has(file) ||
        file.split('/').slice(0, -1).some(part => part.startsWith('.') || TEST_DIRS.has(part))) continue;
    if (!include.some(pattern => globMatches(pattern, file)) ||
        exclude.some(pattern => globMatches(pattern, file))) continue;
    const bytes = readFileSync(join(root, file));
    if (sha(bytes) !== manifest[file]) throw new Error(`profile source changed while building input: ${file}`);
    sources.set(file, { hash: manifest[file], an: analyse(bytes.toString('utf8'), { strict: true }) });
  }
  return sources;
}

export const sourceRows = sources => sortedObject([...sources].map(([file, source]) =>
  [file, { coverable: formatLines(source.an.coverable), hash: source.hash }]));

function lineMap(intervals, sources) {
  const result = new Map();
  for (const [file, ranges] of Object.entries(intervals)) {
    const source = sources.get(file);
    if (!source) continue;
    const lines = coveredLines(source.an, ranges);
    if (lines.length) result.set(file, lines);
  }
  return result;
}

const lineObject = map => sortedObject([...map].map(([file, lines]) => [file, formatLines(lines)]));

/** Fold repeated verified per-test intervals with the ordinary line rule. */
export function profileCoverage(attempts, sources) {
  const unstable = new Map();
  const ids = attempts[0].rows.filter(row => row.status !== 'skipped').map(row => row.id);
  const byTest = sortedObject(ids.map(id => [attempts[0].rows.find(row => row.id === id).canonicalId,
    lineObject(foldRuns(attempts.map(attempt => lineMap(attempt.verifiedCoverage.byTest[id], sources)), unstable))]));
  const setup = lineObject(foldRuns(attempts.map(attempt => lineMap(attempt.verifiedCoverage.setup, sources)), unstable));
  return { granularity: 'test', byTest,
    setup: sortedObject([[attempts[0].file, setup]]),
    ...(attempts.length > 1 ? { unstable: unstableObject(unstable) } : {}) };
}
