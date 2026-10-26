import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { prepareSealedBaseline } from '../baseline.mjs';
import { guardedFull, verifyMethod } from '../../s16/methods.mjs';
import { baseCommit, baseRoot, cases, EXPECTED_S18_PRODUCER, files,
  inputPolicy, verifyProducerPins, verifyPublicLane } from './fixture.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const dir = resolve(process.argv[2] ?? '');
if (!dir.startsWith(join(repo, '.scratch/s18/measure-real/')))
  throw new Error('S18 real preparation output must be under .scratch/s18/measure-real');
mkdirSync(dir, { recursive: false });
const nodePath = process.execPath;
const start = performance.now();
const pins = verifyProducerPins();
const pinMs = performance.now() - start;
const fixtureStart = performance.now();
const fixture = verifyPublicLane();
const prerequisiteMs = performance.now() - fixtureStart;
const prepareStart = performance.now();
const sealed = prepareSealedBaseline({ baseRoot, baseCommit, input: fixture.input,
  fullFiles: files, inputPolicy, nodePath, out: join(dir, 'sealed'),
  expectedProducerHash: EXPECTED_S18_PRODUCER });
const sealedPrepareMs = performance.now() - prepareStart;
if (sealed.baselineTests !== 65 || sealed.baselineFiles !== 4 ||
  sealed.artifactBytes !== statSync(sealed.artifactPath).size)
  throw new Error('S18 real baseline inventory or artifact byte count differs');
const fullOracles = {};
for (const item of cases) {
  const full = guardedFull({ caseName: item.name, nodePath,
    out: join(dir, `${item.name}-full-oracle`) });
  const proof = verifyMethod(full, item.name, full.rows);
  if (proof.fullTests !== 65 || proof.fullFailures !== item.failures)
    throw new Error(`${item.name}: full fault oracle mismatch`);
  fullOracles[item.name] = { rows: full.rows, proof, wallMs: full.wallMs,
    exit: full.exit, privacy: full.proof };
}
const result = { version: 'cupel-s18-real-measure/1', host: { node: process.version,
  nodePath, platform: process.platform, arch: process.arch }, pins, baseCommit,
  inputPolicy, fullFiles: files, gitMetadata: fixture.metadata,
  prerequisite: { status: fixture.collectorPrerequisite,
    collectorInputHash: fixture.collectorInputHash,
    collectorInputBytes: fixture.collectorInputBytes, verificationMs: prerequisiteMs,
    producerPinMs: pinMs },
  preparation: { sealedPrepareMs, artifactPath: sealed.artifactPath,
    artifactHash: sealed.artifactHash, artifactBytes: sealed.artifactBytes,
    baselineTests: sealed.baselineTests, baselineFiles: sealed.baselineFiles },
  fullOracles };
writeFileSync(join(dir, 'prepared.json'), `${JSON.stringify(result, null, 2)}\n`,
  { flag:'wx', mode:0o600 });
process.stdout.write(JSON.stringify({ node: process.version, artifactBytes: sealed.artifactBytes,
  sealedPrepareMs, prerequisiteMs, faults: Object.fromEntries(Object.entries(fullOracles)
    .map(([name, value]) => [name, value.proof.fullFailures])) }) + '\n');
