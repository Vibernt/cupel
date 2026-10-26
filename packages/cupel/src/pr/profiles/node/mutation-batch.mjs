import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cmp } from '../../../engine/order.mjs';
import { nodeProfileProducerProof } from '../../producer.mjs';
import { runNodeProfileAttempt } from './attempt.mjs';
import { mutationPipeSpec } from './mutation-host.mjs';
import { profileMutationFiles } from './selection.mjs';
import { profileRequestSnapshot, runtimeVersion } from './snapshot.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = rows => [...rows].sort((a, b) => cmp(a, b));

function compareAttempt(attempt, input, expectedIdentity, file) {
  if (attempt.kind !== 'complete')
    throw new Error(`Node PR profile execution refused ${file}: ${attempt.reasons.join('; ')}`);
  for (const key of ['inputManifestHash', 'dependencyLockHash', 'profileRuntimeHash', 'environmentPolicyHash'])
    if (attempt.identity[key] !== expectedIdentity[key])
      throw new Error(`Node PR ${key} changed during mutation`);
  const expected = sorted(input.tests.filter(row => row.file === file).map(row => row.id));
  const actual = sorted(attempt.rows.map(row => row.canonicalId));
  if (!same(actual, expected)) throw new Error(`Node PR test identity changed during mutation: ${file}`);
  return attempt;
}

/** Run an explicitly enumerated mutant batch and two fresh survivor confirmations. */
export function runNodeProfileMutationBatch({ root, input, selectedMutants, out,
  nodePath = process.execPath, inputPolicy = 'strict-v1', expectedProducerHash,
  expectedIdentity, expectedDependencies, maxSeconds = 300 }) {
  if (!root || !out || !input || input.runtime?.name !== 'node' ||
      input.runtime.version !== '26.7.0' || !Array.isArray(selectedMutants) ||
      !selectedMutants.length || !expectedIdentity ||
      !expectedDependencies || typeof expectedDependencies !== 'object' ||
      !Number.isFinite(maxSeconds) || maxSeconds <= 0)
    throw new Error('Node PR mutation requires pinned input, explicit mutants, dependencies and a finite budget');
  if (runtimeVersion(nodePath) !== '26.7.0')
    throw new Error('Node v2 selective mutation requires verified Node 26.7.0');
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedProducerHash ?? '') ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR mutation producer differs from trusted pin');
  root = resolve(root); out = resolve(out);
  if (out === root || out.startsWith(`${root}${sep}`)) throw new Error('private output must be outside subject root');
  const files = sorted(new Set(input.tests.map(row => row.file)));
  const initial = profileRequestSnapshot({ root, files, version: '26.7.0', inputPolicy });
  if (!same(initial.identity, expectedIdentity))
    throw new Error('Node PR mutation input or environment differs from collected identity');
  const deadline = performance.now() + maxSeconds * 1000;
  const unique = new Set();
  const jobs = selectedMutants.map(mutant => {
    if (!mutant || typeof mutant.source !== 'string' || typeof mutant.id !== 'string' ||
        !Number.isSafeInteger(mutant.line) || mutant.line < 1 || unique.has(mutant.id) ||
        !Object.hasOwn(input.sources, mutant.source))
      throw new Error('Node PR mutant batch has duplicate or unbound site identity');
    unique.add(mutant.id);
    const spec = mutationPipeSpec({ root, source: mutant.source,
      sourceHash: input.sources[mutant.source].hash, mutantId: mutant.id });
    if (spec.mutant.line !== mutant.line)
      throw new Error('Node PR mutant site line differs from regenerated descriptor');
    return { spec, files: profileMutationFiles(input, mutant.source, mutant.line) };
  });
  mkdirSync(out);
  const baselines = new Map();
  let serial = 0;
  const run = (file, spec = null) => {
    if (performance.now() >= deadline) throw new Error('Node PR mutation budget exhausted before completion');
    const attempt = runNodeProfileAttempt({ root, file, out: join(out, `attempt-${serial++}`),
      nodePath, inputPolicy, expectedProducerHash, expectedDependencies,
      mutationSpec: spec });
    compareAttempt(attempt, input, expectedIdentity, file);
    if (performance.now() >= deadline) throw new Error('Node PR mutation budget exhausted during execution');
    return attempt;
  };
  const allFiles = sorted(new Set(jobs.flatMap(job => job.files)));
  for (const file of allFiles) {
    const baseline = run(file);
    const expected = input.tests.filter(row => row.file === file);
    if (expected.some(row => row.status === 'failed') || baseline.rows.some(row =>
        row.status !== expected.find(item => item.id === row.canonicalId).status))
      throw new Error(`Node PR unmutated baseline changed or failed: ${file}`);
    baselines.set(file, baseline);
  }
  const results = [];
  for (const job of jobs) {
    const mutant = job.spec.mutant;
    if (!job.files.length) {
      results.push({ id: mutant.id, source: mutant.source, line: mutant.line,
        operator: mutant.operator, status: 'no-coverage', confirmations: 0 });
      continue;
    }
    let status = 'survived', confirmations = 0;
    const killedBy = new Set();
    for (let repetition = 0; repetition < 3; repetition++) {
      for (const file of job.files) {
        const result = run(file, job.spec);
        for (const row of result.rows) {
          const base = baselines.get(file).rows.find(item => item.canonicalId === row.canonicalId);
          if (base.status === 'passed' && row.status === 'failed') killedBy.add(row.canonicalId);
          else if (base.status !== row.status)
            throw new Error(`Node PR mutant changed an untrusted test status: ${row.canonicalId}`);
        }
      }
      if (killedBy.size) { status = 'killed'; break; }
      if (repetition > 0) confirmations++;
    }
    results.push({ id: mutant.id, source: mutant.source, line: mutant.line,
      operator: mutant.operator, status, confirmations,
      ...(killedBy.size ? { killedBy: sorted(killedBy) } : {}) });
  }
  const final = profileRequestSnapshot({ root, files, version: '26.7.0', inputPolicy });
  if (!same(final.identity, expectedIdentity) ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR input or producer changed during mutation batch');
  return { kind: 'complete', profile: 'node-readonly-files-v2',
    scope: 'explicit-mutant-batch', mutants: results,
    attempts: serial, complete: true,
    costs: { totalMs: Math.round(performance.now() - (deadline - maxSeconds * 1000)) } };
}
