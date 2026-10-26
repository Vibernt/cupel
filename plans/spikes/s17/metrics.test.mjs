import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConfirmationMetrics, assertSourceMetrics, FACT_CAP_BYTES, SOURCE_METRICS } from './metrics.mjs';

const sample = () => Object.fromEntries(SOURCE_METRICS.map(key => [key, 0]));

test('source counters are explicit and retained facts have a 32 MiB cap', () => {
  const metrics = { ...sample(), textBuilds: 2, factHits: 2, factBytes: FACT_CAP_BYTES };
  assert.equal(assertSourceMetrics(metrics), metrics);
  assert.throws(() => assertSourceMetrics({ ...metrics, factBytes: FACT_CAP_BYTES + 1 }), /exceeds 32 MiB/);
  assert.throws(() => assertSourceMetrics({ ...metrics, sourceChecks: -1 }), /sourceChecks/);
  assert.throws(() => assertSourceMetrics({ ...metrics, factHits: 3 }), /fact hits exceed/);
  const absent = { ...metrics };
  delete absent.lexScans;
  assert.throws(() => assertSourceMetrics(absent), /lexScans/);
});

test('survivor confirmation requires explicit bounded source facts', () => {
  const metrics = { ...sample(), factHits: 2, factBytes: 100 };
  assert.equal(assertConfirmationMetrics(metrics, 1), metrics);
  assert.throws(() => assertConfirmationMetrics({ ...metrics, factHits: 3 }, 1), /two fresh repetitions/);
  const missing = { ...metrics };
  delete missing.sourceReads;
  assert.throws(() => assertConfirmationMetrics(missing, 1), /sourceReads/);
  assert.doesNotThrow(() => assertConfirmationMetrics({}, 0));
});
