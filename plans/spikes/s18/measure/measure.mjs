import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readArtifact } from '../artifact.mjs';
import { validateBundle } from '../../s12b/evidence.mjs';
import { assertSameRows } from '../../s16/oracle.mjs';
import { measureArtifactCost } from './artifact-cost.mjs';
import { executeMethod, assertEquivalentSelections } from './methods.mjs';
import { amortized, median, pairOrder } from './schedule.mjs';
import { baseRoot, cases, EXPECTED_S18_PRODUCER, verifyProducerPins,
  verifyPublicLane } from './fixture.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const dir = resolve(process.argv[2] ?? '');
if (!dir.startsWith(join(repo, '.scratch/s18/measure-real/')))
  throw new Error('S18 real measurement output must be under .scratch/s18/measure-real');
const prepared = JSON.parse(readFileSync(join(dir, 'prepared.json')));
if (prepared.version !== 'cupel-s18-real-measure/1' ||
  prepared.preparation.artifactPath !== join(dir, 'sealed/sealed-baseline.json') ||
  prepared.preparation.artifactBytes !== statSync(prepared.preparation.artifactPath).size ||
  prepared.host.node !== process.version || prepared.host.nodePath !== process.execPath ||
  prepared.pins.s18 !== EXPECTED_S18_PRODUCER)
  throw new Error('S18 measured setup differs from pinned preparation');
const pins = verifyProducerPins();
const source = verifyPublicLane();
if (JSON.stringify(source.metadata) !== JSON.stringify(prepared.gitMetadata) ||
  source.collectorInputHash !== prepared.prerequisite.collectorInputHash)
  throw new Error('real Express metadata or saved collector input changed');
const contextStarted = performance.now();
const artifact = readArtifact(prepared.preparation.artifactPath, prepared.preparation.artifactHash);
const s16Context = { bundle: artifact.baseline.bundle,
  baselineArgs: { ...artifact.args, baseRoot } };
const baselineError = validateBundle(s16Context.bundle, s16Context.baselineArgs);
if (baselineError) throw new Error(`S16 baseline context differs: ${baselineError}`);
const s16ContextLoadMs = performance.now() - contextStarted;
const artifactCost = measureArtifactCost(prepared.preparation.artifactPath,
  prepared.preparation.artifactHash);

const compact = call => ({ method:call.method, wallMs:call.wallMs, proof:call.proof,
  ...(call.decision ? { decision:call.decision } : {}),
  ...(call.assessment ? { assessment:call.assessment } : {}),
  ...(call.timings ? { timings:call.timings } : {}),
  ...(call.counters ? { counters:call.counters } : {}),
  ...(call.capture?.selectedHead ? { selectedRows:call.capture.selectedHead.rows,
    childTimings:call.capture.timings } : {}),
  ...(call.rows ? { fullRows:call.rows, privacy:call.privacy,
    exit:call.exit, processMs:call.processMs } : {}) });
function one(item, method, label) {
  const run = executeMethod({ method, caseName:item.name, out:join(dir, label),
    nodePath:process.execPath, prepared, s16Context });
  writeFileSync(join(dir, `${label}.json`), `${JSON.stringify(compact(run), null, 2)}\n`,
    { flag:'wx', mode:0o600 });
  return run;
}
function pairs(item, a, b) {
  const rows = [];
  for (let index = 0; index < 5; index++) {
    const runs = {};
    const order = pairOrder(index, a, b);
    for (const method of order) runs[method] = one(item, method,
      `${item.name}-${a}-${b}-${index + 1}-${method}`);
    if (runs.s16 && runs.s18) assertEquivalentSelections(runs.s16, runs.s18,
      `${item.name} pair ${index + 1}`);
    if (runs.s18 && runs.full)
      assertSameRows(runs.s18.capture.selectedHead.rows,
        runs.full.rows.filter(row => runs.s18.decision.files.includes(row.file)),
        `${item.name} S18/full pair ${index + 1}`);
    rows.push({ pair:index + 1, order, [a]:runs[a].wallMs, [b]:runs[b].wallMs });
  }
  return { rows, medians: { [a]:median(rows.map(row => row[a])),
    [b]:median(rows.map(row => row[b])) },
    wins: { [a]:rows.filter(row => row[a] < row[b]).length,
      [b]:rows.filter(row => row[b] < row[a]).length } };
}
const summary = { version:'cupel-s18-real-timing/1', host:prepared.host,
  pins, baseCommit:prepared.baseCommit, inputPolicy:prepared.inputPolicy,
  artifact: { bytes:prepared.preparation.artifactBytes,
    hash:prepared.preparation.artifactHash, cost:artifactCost },
  setup: { producerPinMs:prepared.prerequisite.producerPinMs,
    savedCollectorVerificationMs:prepared.prerequisite.verificationMs,
    sealedPrepareMs:prepared.preparation.sealedPrepareMs,
    s16ContextLoadMs, collectorPrerequisite:prepared.prerequisite.status }, cases:{} };
for (const item of cases) {
  const warmups = {};
  for (const method of ['s16','s18','full']) warmups[method] = one(item, method,
    `${item.name}-warmup-${method}`).wallMs;
  const s16S18 = pairs(item, 's16', 's18');
  const s18Full = pairs(item, 's18', 'full');
  const setupMs = summary.setup.producerPinMs + summary.setup.savedCollectorVerificationMs +
    summary.setup.sealedPrepareMs;
  summary.cases[item.name] = { warmups, s16S18, s18Full,
    amortizedS18Ms: amortized(setupMs, s18Full.medians.s18),
    fullOracleFailures:item.failures, selectedFiles:item.selectedFiles };
  process.stdout.write(`${item.name}: S16 ${Math.round(s16S18.medians.s16)} ms, ` +
    `S18 ${Math.round(s16S18.medians.s18)} / ${Math.round(s18Full.medians.s18)} ms, ` +
    `guarded full ${Math.round(s18Full.medians.full)} ms\n`);
}
verifyProducerPins();
writeFileSync(join(dir, 'timing-summary.json'), `${JSON.stringify(summary, null, 2)}\n`,
  { flag:'wx', mode:0o600 });
process.stdout.write(`${join(dir, 'timing-summary.json')}\n`);
