import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { captureNodeProfile } from '../s12b/node-profile/launch.mjs';
import { makeNodeProfileBundle, nodeVersion } from '../s12b/evidence-node-context.mjs';
import { validateBundle } from '../s12b/evidence.mjs';
import { ARTIFACT_VERSION, writeArtifact } from './artifact.mjs';
import { sealedProducerProof } from './producer.mjs';
import { validateSealedBaseline } from './validation.mjs';

const pin = value => /^sha256:[0-9a-f]{64}$/.test(value);
const allowed = new Set(['baseRoot', 'baseCommit', 'input', 'fullFiles',
  'inputPolicy', 'nodePath', 'out', 'expectedProducerHash']);

/** Capture and validate real trusted baseline once; never synthesize a baseline sidecar. */
export function prepareSealedBaseline(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts) ||
    Object.keys(opts).some(key => !allowed.has(key)))
    throw new Error('S18 prepare options invalid or contain caller context');
  const { baseRoot, baseCommit, input, fullFiles, inputPolicy, nodePath, out,
    expectedProducerHash } = opts;
  if (!baseRoot || !baseCommit || !input || !Array.isArray(fullFiles) ||
    !fullFiles.length || !inputPolicy || !nodePath || !out || !pin(expectedProducerHash))
    throw new Error('S18 prepare requires complete baseline inputs and producer pin');
  const root = resolve(baseRoot), output = resolve(out);
  if (output === root || output.startsWith(`${root}${sep}`))
    throw new Error('S18 private output must be outside baseline root');
  const beforeProducer = sealedProducerProof();
  if (beforeProducer.producerHash !== expectedProducerHash)
    throw new Error('S18 preparation producer differs from independent pin');
  const runtime = nodeVersion(nodePath);
  mkdirSync(output, { recursive: true });
  const capture = captureNodeProfile({ root, files: fullFiles, inputPolicy,
    nodePath, out: join(output, 'baseline-capture') });
  if (capture.constrainedFull?.parity !== true || !capture.ordinaryFull)
    throw new Error('S18 real baseline full parity incomplete');
  const { args, bundle } = makeNodeProfileBundle({ baseRoot: root, input,
    sidecar: capture.sidecar, nodePath, baseCommit, inputPolicy });
  const error = validateBundle(bundle, args);
  if (error) throw new Error(`S18 actual baseline validation: ${error}`);
  const afterProducer = sealedProducerProof();
  if (afterProducer.producerHash !== expectedProducerHash ||
    JSON.stringify(afterProducer.producer) !== JSON.stringify(beforeProducer.producer))
    throw new Error('S18 producer source changed during baseline preparation');
  const { baseRoot: omitted, ...savedArgs } = args;
  void omitted;
  const artifact = { version: ARTIFACT_VERSION, baseCommit, inputPolicy,
    producer: beforeProducer.producer, producerHash: beforeProducer.producerHash,
    args: savedArgs, baseline: { bundle,
      rows: { ordinary: capture.ordinaryFull.rows, constrained: capture.constrainedFull.rows },
      lock: { lockHash: args.config.dependencyLockHash,
        packages: args.config.lockedPackages }, fullFiles: [...fullFiles].sort() } };
  validateSealedBaseline(artifact, { expectedBaseCommit: baseCommit,
    expectedProducerHash, producer: beforeProducer.producer, runtime, inputPolicy });
  const result = writeArtifact(output, artifact, root);
  return { ...result, baseCommit, producerHash: expectedProducerHash,
    baselineTests: capture.ordinaryFull.rows.length, baselineFiles: fullFiles.length };
}
