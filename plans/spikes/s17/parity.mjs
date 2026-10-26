import assert from 'node:assert/strict';

export const LEGACY_METRICS = ['generated', 'sites', 'textBuilds', 'valid', 'invalid', 'run'];

export function assertMutationParity(old, current, name) {
  assert.deepEqual(old.mutation, current.mutation, `${name}: mutation output changed`);
  assert.deepEqual(old.confirmed, current.confirmed, `${name}: confirmation output changed`);
  assert.deepEqual(old.counts, current.counts, `${name}: run counts changed`);
  for (const key of LEGACY_METRICS) {
    assert.equal(old.metrics[key], current.metrics[key], `${name}: ${key} changed`);
  }
}

export function median(values) {
  if (!values.length || values.some(x => !Number.isFinite(x))) throw new Error('median needs finite samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(values.length / 2)];
}
