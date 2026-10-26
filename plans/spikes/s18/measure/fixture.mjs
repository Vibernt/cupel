import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealedProducerProof } from '../producer.mjs';
import { currentProducerProof, EXPECTED_PRODUCER } from '../../s16/frozen-producer.mjs';
import { assertPinnedMetadata, baseCommit, baseRoot, cases, collectorInput,
  files, inputPolicy, oldScratch } from '../../s16/fixture.mjs';

// Independently recorded after S18's Node 22/26 focused and four-mode oracle gates.
export const EXPECTED_S18_PRODUCER =
  'sha256:797e69818bf163cc661fd659ae633cb82549660d200a0fff9a4e8f0f865ecdfe';

export { baseCommit, baseRoot, cases, files, inputPolicy, oldScratch };

export function verifyPublicLane() {
  const metadata = { base: assertPinnedMetadata(baseRoot) };
  for (const item of cases) metadata[item.name] = assertPinnedMetadata(item.root);
  const input = collectorInput();
  const raw = readFileSync(join(oldScratch, 'collector-input.json'));
  const collectorInputHash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  return { metadata, input, collectorInputHash, collectorInputBytes: raw.length,
    collectorPrerequisite: 'saved existing 65-row collector input; not collected in S18 preparation' };
}

export function verifyProducerPins() {
  const s18 = sealedProducerProof();
  const s16 = currentProducerProof();
  if (s18.producerHash !== EXPECTED_S18_PRODUCER ||
    s16.producerHash !== EXPECTED_PRODUCER.producerHash)
    throw new Error('S18/S16 producer differs from independent frozen pins');
  return { s18: s18.producerHash, s16: s16.producerHash };
}
