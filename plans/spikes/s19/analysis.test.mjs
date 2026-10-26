import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decision, median, totals } from './analysis.mjs';

const call = (selectMs, repeatMs, calls = 100, parseCalls = 100) => ({ profiles: {
  mutation: { calls, selectNs: selectMs * 1e6, parseCalls,
    parseNs: repeatMs * 1e6, firstParseCalls: 0, firstParseNs: 0,
    repeatedParseCalls: parseCalls, repeatedParseNs: repeatMs * 1e6,
    testRows: parseCalls, fileRows: 2, selectedTests: 1, selectedFiles: 1,
    targetedFull: 0, uniqueCoverageStrings: 0 },
  confirmation: { calls: 0, selectNs: 0, parseCalls: 0, parseNs: 0,
    firstParseCalls: 0, firstParseNs: 0, repeatedParseCalls: 0, repeatedParseNs: 0,
    testRows: 0, fileRows: 0, selectedTests: 0, selectedFiles: 0, targetedFull: 0,
    uniqueCoverageStrings: 0 },
} });

test('median and phase totals keep selection separate from whole wall', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.throws(() => median([]));
  assert.deepEqual([totals(call(12, 5)).selectMs, totals(call(12, 5)).repeatedParseMs], [12, 5]);
});

test('both whole-call and repeat-parse gates are required', () => {
  assert.equal(decision([100, 100, 100], [call(9, 9)], 10).selectionGate, false);
  const lowCeiling = decision([100, 100, 100], [call(12, 4)], 10);
  assert.equal(lowCeiling.selectionGate, true);
  assert.equal(lowCeiling.savingCeilingGate, false);
  assert.equal(lowCeiling.eligibleForAstraReview, false);
  const eligible = decision([100, 100, 100], [call(15, 12)], 10, 14);
  assert.equal(eligible.eligibleForAstraReview, true);
  const clockAmbiguous = decision([100, 100, 100], [call(10.01, 10.01, 100000)], 10);
  assert.equal(clockAmbiguous.outerTimerNeeded, true);
  assert.equal(clockAmbiguous.eligibleForAstraReview, false);
  assert.throws(() => decision([0], [call(1, 1)], 10), /invalid control wall/);
  assert.throws(() => decision([100], [call(Number.NaN, 1)], 10), /invalid mutation.selectNs/);
  const broken = call(10, 5);
  broken.profiles.confirmation.parseCalls = 1;
  assert.throws(() => totals(broken), /inconsistent confirmation/);
});
