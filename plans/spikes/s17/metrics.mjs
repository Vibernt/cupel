export const FACT_CAP_BYTES = 32 * 1024 * 1024;

export const SOURCE_METRICS = ['sourceReads', 'sourceBytesHashed', 'sourceChecks', 'factSources',
  'factBytes', 'factHits', 'lexScans', 'bracketScans', 'typescriptScans',
  'validityCalls', 'validityItems'];

function assertCounters(metrics, keys) {
  for (const key of keys) {
    if (!Number.isSafeInteger(metrics[key]) || metrics[key] < 0)
      throw new Error(`missing or invalid source metric: ${key}`);
  }
  if (metrics.factBytes > FACT_CAP_BYTES)
    throw new Error(`retained source-fact payload exceeds 32 MiB: ${metrics.factBytes}`);
}

export function assertSourceMetrics(metrics) {
  assertCounters(metrics, SOURCE_METRICS);
  if (metrics.factHits > metrics.textBuilds)
    throw new Error('fact hits exceed built mutant texts');
  return metrics;
}

export function assertConfirmationMetrics(metrics, survivorCount) {
  if (survivorCount === 0) return metrics;
  assertCounters(metrics, SOURCE_METRICS.slice(0, -2));
  if (metrics.factHits > 2 * survivorCount)
    throw new Error('confirmation fact hits exceed two fresh repetitions per survivor');
  return metrics;
}
