import { cmp } from '../engine/order.mjs';
import { lines, union, format } from '../engine/lines.mjs';
import { environment, usage } from './errors.mjs';
import { canonical, digest } from './collection.mjs';

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
    ['sources', (x) => x.sources],
  ];
  for (const { file, input } of parts.slice(1)) for (const [field, get] of comparisons) {
    if (!same(get(first), get(input))) throw environment(`${firstFile} and ${file} differ in ${field}`);
  }
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
    sources: first.sources,
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
  cov.byTest = sorted(cov.byTest);
  cov.setup = sorted(cov.setup);
  if (cov.byFile) cov.byFile = sorted(cov.byFile);
  if (cov.unstable) cov.unstable = sorted(cov.unstable);
  if (cov.rechecked) cov.rechecked.sort(cmp);
  if (merged.shapes) merged.shapes = sorted(merged.shapes);
  if (merged.brittleness) merged.brittleness.sort((a, b) => cmp(a.test, b.test) || cmp(a.kind, b.kind) || a.line - b.line || Number(a.deliberate === true) - Number(b.deliberate === true));
  return merged;
}
