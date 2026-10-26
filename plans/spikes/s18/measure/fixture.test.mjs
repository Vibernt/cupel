import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseCommit, files, verifyProducerPins, verifyPublicLane } from './fixture.mjs';

test('real lane pin and saved 65-row prerequisite are explicit', () => {
  const pins = verifyProducerPins();
  assert.match(pins.s18, /^sha256:[0-9a-f]{64}$/);
  const lane = verifyPublicLane();
  assert.equal(lane.metadata.base.commit, baseCommit);
  assert.equal(files.length, 4);
  assert.equal(lane.input.tests.length, 65);
  assert.match(lane.collectorPrerequisite, /not collected in S18 preparation/);
});
