import { cmp } from '../engine/order.mjs';
import { lines, union, format } from '../engine/lines.mjs';
import { environment, usage } from './errors.mjs';
import { canonical, digest } from './collection.mjs';
import { JSX_IN_CHILD, JSX_NOT_LOADED, JSX_NO_MAP, JSX_NO_TYPESCRIPT, JSX_UNPARSED, SOURCE_NO_MAP } from '../collect/node/jsx-reasons.mjs';

const lineUnion = (a = '', b = '') => format(union(lines(a), lines(b)));
const same = (a, b) => canonical(a) === canonical(b);
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => cmp(a, b)));

export function mergeInputs(parts) {
  if (!parts.length) throw usage('merge-inputs needs collection shards');
  const [{ file: firstFile, input: first }] = parts;
  for (const { file, input } of parts) {
    if (input.mutation) throw usage(`${file}: merge shards before mutation`);
    if (input.collection?.subset) throw usage(`${file}: subset inputs cannot be merged`);
    if (!input.collection?.shard) throw usage(`${file}: not a collection shard; collect with --shard`);
  }
  const comparisons = [
    ['spec', (x) => x.spec], ['runtime', (x) => x.runtime], ['runtimes/runner set', (x) => x.runtimes],
    ['coverage.granularity', (x) => x.coverage.granularity], ['collection.runs', (x) => x.collection.runs],
    ['collection.config', (x) => x.collection.config], ['collection.commit', (x) => x.collection.commit],
    ['shard.total', (x) => x.collection.shard.total], ['shard.suite', (x) => x.collection.shard.suite],
  ];
  for (const { file, input } of parts.slice(1)) for (const [field, get] of comparisons) {
    if (!same(get(first), get(input))) throw environment(`${firstFile} and ${file} differ in ${field}`);
  }
  const { sources, dropped } = mergeSources(parts);
  const total = first.collection.shard.total;
  const indices = new Map(), files = new Map(), ids = new Map(), setup = new Map();
  for (const { file, input } of parts) {
    const index = input.collection.shard.index;
    if (indices.has(index)) throw environment(`duplicate shard index ${index}: ${indices.get(index)} and ${file}`);
    indices.set(index, file);
    for (const [path, hash] of Object.entries(input.collection.shard.files)) {
      if (files.has(path)) throw environment(`shard file ${path} overlaps: ${files.get(path)} and ${file}`);
      files.set(path, file);
      if (!hash) throw environment(`${file}: missing hash for ${path}`);
    }
    for (const test of input.tests) {
      if (!Object.hasOwn(input.collection.shard.files, test.file)) throw environment(`${file}: test ${test.id} has file outside shard.files: ${test.file}`);
      if (ids.has(test.id)) throw environment(`duplicate test id ${test.id}: ${ids.get(test.id)} and ${file}`);
      ids.set(test.id, file);
    }
    for (const path of Object.keys(input.coverage.setup ?? {})) {
      if (setup.has(path)) throw environment(`coverage.setup key ${path} overlaps: ${setup.get(path)} and ${file}`);
      setup.set(path, file);
    }
  }
  for (let i = 1; i <= total; i++) if (!indices.has(i)) throw environment(`missing shard index ${i} of ${total}`);
  const suite = digest(JSON.stringify([...parts.flatMap(({ input }) => Object.entries(input.collection.shard.files))].sort(([a], [b]) => cmp(a, b))));
  if (suite !== first.collection.shard.suite) throw environment(`shard.files union does not reproduce shard.suite: ${firstFile}`);

  const merged = {
    spec: first.spec, kind: 'input', runtime: first.runtime,
    ...(first.runtimes ? { runtimes: first.runtimes } : {}),
    sources,
    tests: parts.flatMap(({ input }) => input.tests).sort((a, b) => cmp(a.id, b.id)),
    coverage: { granularity: first.coverage.granularity, byTest: {}, setup: {} },
    collection: { runs: first.collection.runs, ...(first.collection.config ? { config: first.collection.config } : {}),
      ...(first.collection.commit ? { commit: first.collection.commit } : {}) },
  };
  const cov = merged.coverage;
  for (const { input } of parts) {
    Object.assign(cov.byTest, input.coverage.byTest ?? {});
    Object.assign(cov.setup, input.coverage.setup ?? {});
    if (input.coverage.byFile) Object.assign(cov.byFile ??= {}, input.coverage.byFile);
    if (input.coverage.rechecked) (cov.rechecked ??= []).push(...input.coverage.rechecked);
    if (input.coverage.unstable) for (const [source, value] of Object.entries(input.coverage.unstable)) {
      (cov.unstable ??= {})[source] = lineUnion(cov.unstable?.[source], value);
    }
    if (input.brittleness) (merged.brittleness ??= []).push(...input.brittleness);
    if (input.shapes) Object.assign(merged.shapes ??= {}, input.shapes);
  }
  if (dropped.size) {
    // A JSX source one shard could not map is unmeasured as a whole; another shard's lines for it are not kept.
    const strip = (lineMap) => Object.fromEntries(Object.entries(lineMap).filter(([source]) => !dropped.has(source)));
    for (const index of [cov.byTest, cov.setup, cov.byFile]) if (index) for (const key of Object.keys(index)) index[key] = strip(index[key]);
    if (cov.unstable) cov.unstable = strip(cov.unstable);
  }
  cov.byTest = sorted(cov.byTest);
  cov.setup = sorted(cov.setup);
  if (cov.byFile) cov.byFile = sorted(cov.byFile);
  if (cov.unstable) cov.unstable = sorted(cov.unstable);
  if (cov.rechecked) cov.rechecked.sort(cmp);
  if (merged.shapes) merged.shapes = sorted(merged.shapes);
  if (merged.brittleness) merged.brittleness.sort((a, b) => cmp(a.test, b.test) || cmp(a.kind, b.kind) || a.line - b.line || Number(a.deliberate === true) - Number(b.deliberate === true));
  return merged;
}

const JSX = /\.[jt]sx$/;
// Reasons a shard gives a source its own tests ran through a loader but could not measure (K2).
const LOADER_REASONS = [JSX_NO_MAP, JSX_IN_CHILD, JSX_NO_TYPESCRIPT, JSX_UNPARSED, SOURCE_NO_MAP];
const loaderReason = (reason) => LOADER_REASONS.some((r) => reason === r || reason.startsWith(`${r}: `));

/**
 * Shards agree on every source, except one a shard's own tests ran through a loader (K1, K2): JSX, measured only when
 * a shard's tests load it, and any source a loader transformed without a usable source map. With the same hash, an
 * entry a shard loaded but could not measure wins (its reason, the least by text when shards differ), then a measured
 * entry (shards that measured it must agree), then "not loaded".
 * Returns the merged sources and the JSX sources whose lines some shard had but the merge leaves unmeasured.
 */
function mergeSources(parts) {
  const [{ file: firstFile, input: first }] = parts;
  const paths = Object.keys(first.sources);
  const names = (k) => `${firstFile} and ${parts[k].file}`;
  for (const { file, input } of parts.slice(1)) {
    if (!same(Object.keys(input.sources), paths)) throw environment(`${firstFile} and ${file} differ in sources`);
  }
  const sources = {};
  const dropped = new Set();
  for (const path of paths) {
    const entries = parts.map(({ input }) => input.sources[path]);
    if (entries.every((entry) => same(entry, entries[0]))) { sources[path] = entries[0]; continue; }
    const differ = () => environment(`${names(entries.findIndex((entry) => !same(entry, entries[0])))} differ in sources: ${path}`);
    if (entries.some((entry) => entry.hash === undefined || entry.hash !== entries[0].hash)) throw differ();
    const notLoaded = entries.filter((entry) => JSX.test(path) && entry.unmeasured === JSX_NOT_LOADED && entry.coverable === '');
    const unusable = entries.filter((entry) => entry.unmeasured !== undefined && !notLoaded.includes(entry));
    const measured = entries.filter((entry) => entry.unmeasured === undefined);
    if (measured.some((entry) => !same(entry, measured[0]))) throw differ();
    // Only a loader explains shards disagreeing; any other reason (a read failure in one shard) refuses the merge.
    if (unusable.some((entry) => entry.coverable !== '' || !loaderReason(entry.unmeasured))) throw differ();
    if (unusable.length) {
      sources[path] = [...unusable].sort((a, b) => cmp(a.unmeasured, b.unmeasured))[0];
      if (measured.length) dropped.add(path);
    } else sources[path] = measured[0];
  }
  return { sources, dropped };
}
