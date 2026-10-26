import { FROZEN_PROFILE_RUNTIME_HASH } from '../s12b/evidence-node-context.mjs';
import { producerProof } from './producer.mjs';

// Frozen after Node 22/26 coordinator, hook, and transitive engine controls.
export const EXPECTED_PRODUCER = Object.freeze({
  producer: Object.freeze({
    version: 'cupel-s16-producer/1',
    referenceProfileHash: 'sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b',
    hookRuntimeHash: 'sha256:5f25b4af5b4ce35437ed1123bbbc2f5dba66ee195b743516fdd36884fbd562b2',
    requestCoordinatorHash: 'sha256:a1c2663dd38afc384bcae44787bfc493ea011883f18525807bf490a84ea6a474',
  }),
  producerHash: 'sha256:83e34e949d9a178b1dbb0e2b97d7de8eade65f9297466297a9aa88a634cae29a',
});

export const currentProducerProof = () => producerProof(FROZEN_PROFILE_RUNTIME_HASH);

export function withProducerProof(actual, expected, action) {
  if (!expected?.producerHash || !expected.producer ||
    actual?.producerHash !== expected.producerHash ||
    JSON.stringify(actual.producer) !== JSON.stringify(expected.producer))
    throw new Error('S16 accepted producer identity differs from frozen proof');
  return action();
}
