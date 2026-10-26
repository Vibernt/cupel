import assert from 'node:assert/strict';
import test from 'node:test';
import { currentProducerProof, EXPECTED_PRODUCER, withProducerProof } from './frozen-producer.mjs';

const proof = { producerHash: 'sha256:abc', producer: {
  version: 'cupel-s16-producer/1', referenceProfileHash: 'sha256:ref',
  hookRuntimeHash: 'sha256:hook', requestCoordinatorHash: 'sha256:request',
} };

test('producer mismatch refuses before invoking selected runner', () => {
  let selectedProcesses = 0;
  const run = () => { selectedProcesses++; return 'ran'; };
  assert.equal(withProducerProof(proof, structuredClone(proof), run), 'ran');
  assert.equal(selectedProcesses, 1);
  assert.throws(() => withProducerProof(proof,
    { ...proof, producerHash: 'sha256:other' }, run), /differs/);
  assert.throws(() => withProducerProof(proof,
    { ...proof, producer: { ...proof.producer, hookRuntimeHash: 'sha256:other' } }, run), /differs/);
  assert.throws(() => withProducerProof(proof, null, run), /differs/);
  assert.equal(selectedProcesses, 1);
});

test('frozen S16 producer descriptor matches current trusted source', () => {
  assert.deepEqual(currentProducerProof(), EXPECTED_PRODUCER);
});
