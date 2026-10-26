import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSource, PRODUCT_MUTATE_HASH } from './pin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const raw = {
  runtime: '.scratch/s19/runtime-5vPupQ/manifest.json',
  node26: '.scratch/s19/profile-EGUXJ9/results.json',
  node22: '.scratch/s19/profile-eQg53C/results.json',
  launches26: '.scratch/s19/launch-l932li/result.json',
  launches22: '.scratch/s19/launch-WHBIzc/result.json',
  express26: '.scratch/s19/express-replay-0NvLhL/result.json',
  express22: '.scratch/s19/express-replay-WiCn2v/result.json',
};
const read = key => JSON.parse(readFileSync(join(repo, raw[key]), 'utf8'));
const manifest = read('runtime');
assertSource(join(repo, 'packages/cupel/src/mutate'), PRODUCT_MUTATE_HASH);
assertSource(join(repo, 'packages/cupel/src'), manifest.productClosure.sourceHash);
assertSource(join(repo, 'packages/cupel/schemas'), manifest.productClosure.schemaHash);
const results = { version: 'cupel-s19-result/1', verdict: 'no-product-change',
  reason: 'No complete workload reached 10 ms or 5% whole-call selection share; repeated parsing also missed both.',
  sourcePins: { productMutation: PRODUCT_MUTATE_HASH, productClosure: manifest.productClosure,
    control: manifest.copies.control, instrumented: manifest.copies.instrumented },
  raw, runtimes: {} };
for (const [major, profileKey, launchKey, expressKey] of [
  [26, 'node26', 'launches26', 'express26'], [22, 'node22', 'launches22', 'express22']]) {
  const capture = read(profileKey), launches = read(launchKey), replay = read(expressKey);
  assert.equal(capture.runtime, launches.runtime);
  assert.equal(capture.runtime, replay.runtime);
  assert.ok(capture.caseManifest.includes(`approved9e-node${major}`));
  assert.equal(capture.mutationSourcePins.product, PRODUCT_MUTATE_HASH);
  assert.equal(replay.savedInputSha256,
    'de0915855549d16d31251d4a313b8fcb70603625a2903a44b39aeedd4446bce2');
  assert.equal(replay.noCheckoutRead, true);
  assert.equal(replay.noTestExecution, true);
  assert.equal(replay.sampledQueries, 200);
  const cases = {};
  for (const [name, row] of Object.entries(capture.cases)) {
    const selection = row.measured;
    assert.equal(selection.selectionGate, false);
    assert.equal(selection.savingCeilingGate, false);
    assert.equal(selection.outerTimerNeeded, false);
    assert.equal(launches.rows[name].actualJobs, 6);
    cases[name] = { kind: row.label,
      controlWholeMedianMs: selection.denominatorMs,
      selectMedianMs: selection.selectMs,
      selectShare: selection.selectShare,
      repeatedParseMedianMs: selection.repeatedParseMs,
      repeatedParseShare: selection.repeatShare,
      calibratedClockOverheadMs: selection.calibratedClockOverheadMs,
      counts: row.pairs[0].control.counts,
      actualJobs: launches.rows[name].actualJobs,
      launches: launches.rows[name].launches.control,
      callsMutation: row.pairs[0].instrumented.profiles.mutation.calls,
      callsConfirmation: row.pairs[0].instrumented.profiles.confirmation.calls,
      parseCallsMutation: row.pairs[0].instrumented.profiles.mutation.parseCalls,
      parseCallsConfirmation: row.pairs[0].instrumented.profiles.confirmation.parseCalls };
  }
  results.runtimes[`node${major}`] = { version: capture.runtime,
    warmupsPerCase: 1, alternatingPairsPerCase: 3,
    exactMutationConfirmationMetricsAndLaunchParity: true,
    cases,
    expressReplay: { kind: 'input-only kernel replay, excluded from promotion gate',
      totalCoverableUnique: replay.totalAvailableUnique,
      coveredCoverableUnique: replay.coveredAvailableUnique,
      sampledUniqueQueries: replay.sampledQueries,
      selectorMs: replay.profile.selectNs / 1e6,
      repeatedParseMs: replay.profile.repeatedParseNs / 1e6,
      targetedFull: replay.profile.targetedFull,
      nonemptySelectedQueries: replay.selectedRows.filter(row => row.selectedIds.length).length } };
}
writeFileSync(join(repo, 'plans/spikes/s19/results.json'), JSON.stringify(results, null, 2) + '\n');
process.stdout.write(`${join(repo, 'plans/spikes/s19/results.json')}\n`);
