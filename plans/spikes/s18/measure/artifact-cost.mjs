import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readArtifact, rawHash, ARTIFACT_VERSION } from '../artifact.mjs';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Diagnostic only; whole S18 API timing includes its own complete artifact verification. */
export function measureArtifactCost(path, expectedHash, repetitions = 5) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error('artifact diagnostic repetitions out of range');
  const size = statSync(path).size;
  const samples = [];
  for (let i = 0; i < repetitions; i++) {
    let mark = performance.now();
    const bytes = readFileSync(path);
    const readMs = performance.now() - mark;
    mark = performance.now();
    if (rawHash(bytes) !== expectedHash) throw new Error('artifact diagnostic raw hash mismatch');
    const hashMs = performance.now() - mark;
    mark = performance.now();
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.version !== ARTIFACT_VERSION) throw new Error('artifact diagnostic version mismatch');
    const parseMs = performance.now() - mark;
    mark = performance.now();
    readArtifact(path, expectedHash);
    const fullReadArtifactMs = performance.now() - mark;
    samples.push({ readMs, hashMs, parseMs, fullReadArtifactMs });
  }
  return { artifactBytes: size, samples, medians: Object.fromEntries(
    ['readMs', 'hashMs', 'parseMs', 'fullReadArtifactMs'].map(key =>
      [key, median(samples.map(sample => sample[key]))])) };
}
