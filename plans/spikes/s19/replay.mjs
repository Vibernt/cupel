// Input-only Express selection replay. No checkout access, test run or mutant construction.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { newProfile, profileData } from './instrument.mjs';
import { assertSource, PRODUCT_MUTATE_HASH, sha256 } from './pin.mjs';
import { coverageQueries } from './coverage-queries.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const manifestPath = resolve(process.argv[2] ?? '');
assert.ok(manifestPath.startsWith(join(repo, '.scratch/s19/runtime-')),
  'replay requires an ignored S19 runtime manifest');
const runtime = JSON.parse(readFileSync(manifestPath, 'utf8'));
const inputPath = join(repo, '.scratch/s12b/real-lane/collector-input.json');
const EXPECTED_INPUT = 'de0915855549d16d31251d4a313b8fcb70603625a2903a44b39aeedd4446bce2';
const raw = readFileSync(inputPath);
assert.equal(sha256(raw), EXPECTED_INPUT, 'saved Express input changed');
const input = JSON.parse(raw);
assert.equal(input.tests.length, 65, 'saved Express test count differs');
function verify() {
  assertSource(join(repo, 'packages/cupel/src/mutate'), PRODUCT_MUTATE_HASH);
  assertSource(join(repo, 'packages/cupel/src'), runtime.productClosure.sourceHash);
  assertSource(join(repo, 'packages/cupel/schemas'), runtime.productClosure.schemaHash);
  assert.equal(sha256(readFileSync(join(repo, 'packages/cupel/src/engine/lines.mjs'))),
    runtime.productClosure.parserHash);
  for (const copy of Object.values(runtime.copies)) {
    assertSource(dirname(copy.module), copy.mutationSourceHash);
    const src = dirname(dirname(copy.module));
    assertSource(src, copy.sourceHash);
    assertSource(join(src, '../schemas'), copy.schemaHash);
    assert.equal(sha256(readFileSync(join(src, 'engine/lines.mjs'))), copy.parserHash);
  }
  assert.equal(sha256(readFileSync(inputPath)), EXPECTED_INPUT);
}
verify();

const { sourceCount, totalAvailableUnique, coveredAvailableUnique, queries } = coverageQueries(input);
const targetedRow = input.tests.find(test => test.status === 'passed' &&
  Object.keys(input.coverage.byTest?.[test.id] ?? {}).length);
assert.ok(targetedRow, 'saved input has no passed row with coverage');
const targetedUnit = targetedRow.unit ?? targetedRow.id;

async function selector(copy) {
  const src = dirname(dirname(copy.module));
  const packageRoot = dirname(src);
  const { Session } = await import(pathToFileURL(copy.module));
  const { mutationModel } = await import(pathToFileURL(join(src, 'mutate/model.mjs')));
  const { effectiveConfig } = await import(pathToFileURL(join(src, 'engine/config.mjs')));
  const schema = JSON.parse(readFileSync(join(packageRoot, 'schemas/config.schema.json'), 'utf8'));
  const cfg = effectiveConfig({}, schema);
  const session = Object.create(Session.prototype);
  session.input = input;
  session.model = mutationModel(input, cfg, [targetedUnit]);
  session.targetedUnits = new Set([targetedUnit]);
  session.passedByFile = new Map();
  for (const test of input.tests) {
    if (test.status !== 'passed') continue;
    if (!session.passedByFile.has(test.file)) session.passedByFile.set(test.file, []);
    session.passedByFile.get(test.file).push(test);
  }
  return session;
}

globalThis.__CUPEL_S19_PROFILE = newProfile();
const control = await selector(runtime.copies.control);
const measured = await selector(runtime.copies.instrumented);
const rows = [];
for (const q of queries) {
  const a = control.select(q), b = measured.select(q);
  const row = (session, value) => ({ selectedIds: value.tests.map(test => test.id),
    counts: [...value.counts], fileOrder: session.order(value.counts), needsFull: value.needsFull });
  const expected = row(control, a), actual = row(measured, b);
  assert.deepEqual(actual, expected, `${q.source}:${q.line}: selector changed`);
  rows.push({ ...q, ...actual });
}
const profile = profileData(globalThis.__CUPEL_S19_PROFILE);
assert.equal(profile.calls, queries.length);
verify();
const scratch = join(repo, '.scratch/s19');
mkdirSync(scratch, { recursive: true });
const output = mkdtempSync(join(scratch, 'express-replay-'));
const result = { version: 'cupel-s19-express-selection/1', kind: 'input-only kernel replay',
  runtime: process.version, savedInput: inputPath, savedInputSha256: EXPECTED_INPUT,
  noCheckoutRead: true, noTestExecution: true, totalAvailableUnique,
  coveredAvailableUnique, sampledQueries: queries.length,
  defaultMutantBudget: 200, targetedUnit, sourceCount,
  selectedRows: rows, profile };
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(`${join(output, 'result.json')}\n`);
