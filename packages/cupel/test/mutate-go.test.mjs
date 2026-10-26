import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { collectGo } from '../src/collect/go/index.mjs';
import { confirmGo, mutateGo } from '../src/mutate-go/index.mjs';
import { parseInventory } from '../src/mutate-go/inventory.mjs';
import { GoSourceFacts } from '../src/mutate-go/facts.mjs';
import { isInvalidGoSource } from '../src/mutate-go/compile-diagnostics.mjs';
import { run as runGoProcess } from '../src/mutate-go/process.mjs';
import { run as engine } from '../src/engine/index.mjs';
import { schemas } from './engine-helpers.mjs';

const fixture = resolve(import.meta.dirname, 'fixtures/mutate-go');
const scratch = resolve('.scratch', 'mutate-go-tests');
const hash = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

function project(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-'));
  for (const file of ['go.mod', 'value.go', 'value_test.go']) copyFileSync(join(fixture, file), join(root, file));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function tamperDuring(mode, marker, operation) {
  const oldMode = process.env.CUPEL_GO_TAMPER_MODE;
  const oldMarker = process.env.CUPEL_GO_TAMPER_MARKER;
  process.env.CUPEL_GO_TAMPER_MODE = mode;
  if (marker) process.env.CUPEL_GO_TAMPER_MARKER = marker;
  else delete process.env.CUPEL_GO_TAMPER_MARKER;
  try { return await operation(); }
  finally {
    if (oldMode === undefined) delete process.env.CUPEL_GO_TAMPER_MODE;
    else process.env.CUPEL_GO_TAMPER_MODE = oldMode;
    if (oldMarker === undefined) delete process.env.CUPEL_GO_TAMPER_MARKER;
    else process.env.CUPEL_GO_TAMPER_MARKER = oldMarker;
  }
}

test('Go mutation kills behavior, confirms survivor, preserves source pin and schema rows', async (t) => {
  const root = project(t);
  const before = hash(join(root, 'value.go'));
  const input = await collectGo({ root, runs: 1 });
  assert.equal(input.sources['value.go'].hash, before);
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '3,5' },
    targeted: ['value_test.go::TestChoose', 'value_test.go::TestIdentity'] },
    config: { mutation: { maxMutants: 10, maxSeconds: 120, seed: 7 } } });
  assert.equal(mutation.mutants.length, 2);
  assert.deepEqual(mutation.mutants.map((row) => [row.line, row.status]), [[3, 'killed'], [5, 'survived']]);
  assert.deepEqual(mutation.mutants[0].killedBy, ['value_test.go::TestChoose']);
  assert.equal(mutation.mutants.some((row) => row.killedBy?.includes('value_test.go::TestSourcePin')), false);
  assert.equal(mutation.sampled, false);
  assert.deepEqual(mutation.targeted, ['value_test.go::TestChoose', 'value_test.go::TestIdentity']);
  assert.equal(hash(join(root, 'value.go')), before);

  const confirmed = await confirmGo({ root, input, mutation, ids: [mutation.mutants[1].id],
    config: { mutation: { maxSeconds: 120 } } });
  assert.deepEqual(confirmed, mutation);
  assert.equal(hash(join(root, 'value.go')), before);

  const historical = structuredClone(mutation);
  historical.mutants[0].status = 'survived';
  delete historical.mutants[0].killedBy;
  const redetected = await confirmGo({ root, input, mutation: historical, ids: [historical.mutants[0].id],
    config: { mutation: { maxSeconds: 120 } } });
  assert.deepEqual(redetected.mutants, mutation.mutants);
  assert.deepEqual(redetected.targeted, mutation.targeted);

  const base = { ...input, mutation };
  const head = structuredClone(base);
  head.mutation.mutants[0].status = 'survived';
  delete head.mutation.mutants[0].killedBy;
  const guarded = engine('guard', { base, head }, { tiers: { critical: ['value.go'] } }, {}, schemas);
  assert.equal(guarded.exit, 1);
  assert.deepEqual(guarded.report.guard.checks.find((row) => row.id === 'critical-mutation').lost,
    { mutants: [mutation.mutants[0].id] });
});

test('Go confirmation refuses stale source bytes and missing canonical input hash', async (t) => {
  const root = project(t);
  const input = await collectGo({ root, runs: 1 });
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '5' } },
    config: { mutation: { maxMutants: 1, maxSeconds: 120 } } });
  assert.equal(mutation.mutants[0].status, 'survived');
  const missing = structuredClone(input);
  delete missing.sources['value.go'].hash;
  await assert.rejects(() => confirmGo({ root, input: missing, mutation, ids: [mutation.mutants[0].id] }),
    { code: 'source-hash' });
  writeFileSync(join(root, 'value.go'), readFileSync(join(root, 'value.go'), 'utf8').replace('n + 0', 'n + 1'));
  await assert.rejects(() => confirmGo({ root, input, mutation, ids: [mutation.mutants[0].id] }),
    { code: 'source-changed' });
});

test('Go compile-invalid mutation is excluded and a partial test inventory is refused', async (t) => {
  const root = project(t);
  const input = await collectGo({ root, runs: 1 });
  const metrics = {};
  const invalid = await mutateGo({ root, input, scope: { changed: { 'value.go': '7' } },
    config: { mutation: { maxMutants: 1, maxSeconds: 120 } }, metrics });
  assert.deepEqual(invalid.mutants, []);
  assert.equal(metrics.invalid, 1);
  assert.equal(invalid.sampled, false);

  const partial = structuredClone(input);
  partial.tests = partial.tests.filter((row) => row.name !== 'TestChoose');
  delete partial.coverage.byTest['value_test.go::TestChoose'];
  delete partial.shapes['value_test.go::TestChoose'];
  partial.coverage.rechecked = partial.coverage.rechecked.filter((id) => id !== 'value_test.go::TestChoose');
  await assert.rejects(() => mutateGo({ root, input: partial, scope: { changed: { 'value.go': '5' } } }),
    { code: 'isolation-mismatch' });
});

test('Go source overlay refuses embed and unsupported native channels', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'data.txt'), 'local fixture');
  writeFileSync(join(root, 'value.go'), `${readFileSync(join(root, 'value.go'), 'utf8')}\n//go:embed data.txt\nvar embedded string\n`);
  const source = readFileSync(join(root, 'value.go'), 'utf8').replace('package fixture', 'package fixture\n\nimport _ "embed"');
  writeFileSync(join(root, 'value.go'), source);
  const input = await collectGo({ root, runs: 1 });
  await assert.rejects(() => mutateGo({ root, input, scope: { changed: { 'value.go': '' } } }),
    { code: 'unsupported-go-channel' });
  assert.throws(() => parseInventory(root, JSON.stringify({ ImportPath: 'example.com/native', CgoFiles: ['native.go'] }), input),
    { code: 'unsupported-go-channel' });
});

test('Go mutation refuses build tags and compiler environment drift', async (t) => {
  const root = project(t);
  const source = readFileSync(join(root, 'value.go'), 'utf8');
  writeFileSync(join(root, 'value.go'), `//go:build go1.22\n\n${source}`);
  const input = await collectGo({ root, runs: 1 });
  await assert.rejects(() => mutateGo({ root, input, scope: { changed: { 'value.go': '' } } }),
    { code: 'unsupported-go-channel' });

  const plainRoot = project(t);
  const plain = await collectGo({ root: plainRoot, runs: 1 });
  const wrongRuntime = structuredClone(plain);
  wrongRuntime.runtime.version = '1.99.0';
  await assert.rejects(() => mutateGo({ root: plainRoot, input: wrongRuntime,
    scope: { changed: { 'value.go': '3' } } }), { code: 'go-runtime' });
  const old = process.env.GOFLAGS;
  process.env.GOFLAGS = '-tags=custom';
  try {
    await assert.rejects(() => mutateGo({ root: plainRoot, input: plain,
      scope: { changed: { 'value.go': '3' } } }), { code: 'unsupported-go-environment' });
  } finally {
    if (old === undefined) delete process.env.GOFLAGS;
    else process.env.GOFLAGS = old;
  }
});

test('Go targeted cap marks only the fully completed unit and rejects function scope', async (t) => {
  const root = project(t);
  const input = await collectGo({ root, runs: 1 });
  const requested = ['value_test.go::TestChoose', 'value_test.go::TestIdentity'];
  const mutation = await mutateGo({ root, input, scope: { targeted: requested },
    config: { mutation: { maxMutants: 1, maxSeconds: 120, seed: 11 } } });
  assert.equal(mutation.mutants.length, 1);
  assert.equal(mutation.mutants[0].line, 3);
  assert.deepEqual(mutation.targeted, ['value_test.go::TestChoose']);
  assert.equal(mutation.sampled, true);
  await assert.rejects(() => mutateGo({ root, input, scope: { functions: true } }),
    { code: 'unsupported-scope' });
});

test('Go process abort cannot be credited as a test kill', async (t) => {
  const root = project(t);
  const extra = '\nfunc TestAbort(t *testing.T) { if Choose(2) != 3 { os.Exit(7) } }\n';
  writeFileSync(join(root, 'value_test.go'), readFileSync(join(root, 'value_test.go'), 'utf8') + extra);
  const input = await collectGo({ root, runs: 1 });
  const mutation = await mutateGo({ root, input, scope: { changed: { 'value.go': '3' } },
    config: { mutation: { maxMutants: 1, maxSeconds: 120 } } });
  assert.equal(mutation.mutants.length, 1);
  assert.equal(mutation.mutants[0].status, 'error');
  assert.equal(mutation.mutants[0].killedBy, undefined);
});

test('Go refuses source writes during baseline, mutant run and historical confirmation', async (t) => {
  const reference = project(t);
  const input = await collectGo({ root: reference, runs: 1 });

  const staleRoot = project(t);
  writeFileSync(join(staleRoot, 'value.go'), `${readFileSync(join(staleRoot, 'value.go'), 'utf8')}\n// stale before baseline\n`);
  await assert.rejects(() => mutateGo({ root: staleRoot, input, scope: { changed: { 'value.go': '3' } } }),
    { code: 'source-changed' });

  const baselineRoot = project(t);
  await assert.rejects(() => tamperDuring('always', null, () => mutateGo({
    root: baselineRoot, input, scope: { changed: { 'value.go': '3' } },
    config: { mutation: { maxSeconds: 120 } },
  })), { code: 'source-changed' });

  const testFileRoot = project(t);
  await assert.rejects(() => tamperDuring('test-file', null, () => mutateGo({
    root: testFileRoot, input, scope: { changed: { 'value.go': '3' } },
    config: { mutation: { maxSeconds: 120 } },
  })), { code: 'source-changed' });

  const mutantRoot = project(t);
  await assert.rejects(() => tamperDuring('after-first', join(mutantRoot, '.scratch', 'marker'), () => mutateGo({
    root: mutantRoot, input, scope: { changed: { 'value.go': '3' } },
    config: { mutation: { maxSeconds: 120 } },
  })), { code: 'source-changed' });

  const confirmRoot = project(t);
  const mutation = await mutateGo({ root: confirmRoot, input, scope: { changed: { 'value.go': '5' } },
    config: { mutation: { maxMutants: 1, maxSeconds: 120 } } });
  assert.equal(mutation.mutants[0].status, 'survived');
  await assert.rejects(() => tamperDuring('after-first', join(confirmRoot, '.scratch', 'marker'), () => confirmGo({
    root: confirmRoot, input, mutation, ids: [mutation.mutants[0].id],
    config: { mutation: { maxSeconds: 120 } },
  })), { code: 'source-changed' });
});

test('Go rejects private and symlinked files before any inventory or source read', async (t) => {
  const root = project(t);
  const baseline = await collectGo({ root, runs: 1 });
  mkdirSync(join(root, 'credentials'));
  writeFileSync(join(root, 'credentials', 'private.go'), 'do not read');
  symlinkSync(join(root, 'credentials', 'private.go'), join(root, 'zz-linked.go'));
  const privateInput = structuredClone(baseline);
  privateInput.sources['credentials/private.go'] = { hash: hash(join(root, 'value.go')) };
  const factsMetrics = {};
  assert.throws(() => new GoSourceFacts(root, privateInput, factsMetrics), { code: 'source-path' });
  assert.equal(factsMetrics.sourceReads ?? 0, 0);

  const symlinkInput = structuredClone(baseline);
  symlinkInput.sources['zz-linked.go'] = { hash: hash(join(root, 'value.go')) };
  const symlinkMetrics = {};
  assert.throws(() => new GoSourceFacts(root, symlinkInput, symlinkMetrics), { code: 'source-path' });
  assert.equal(symlinkMetrics.sourceReads ?? 0, 0);

  const listed = (files) => JSON.stringify({ ImportPath: 'example.com/fixture', Dir: root, GoFiles: files,
    TestGoFiles: ['value_test.go'] });
  const inventoryMetrics = {};
  assert.throws(() => parseInventory(root, listed(['value.go', 'credentials/private.go']), baseline, inventoryMetrics),
    { code: 'source-path' });
  assert.equal(inventoryMetrics.inventoryReads ?? 0, 0);
  const linkMetrics = {};
  assert.throws(() => parseInventory(root, listed(['value.go', 'zz-linked.go']), baseline, linkMetrics),
    { code: 'source-path' });
  assert.equal(linkMetrics.inventoryReads ?? 0, 0);
});

test('Go compile invalidity requires an ordinary target-source diagnostic', () => {
  const result = (stderr, extra = {}) => ({ status: 1, signal: null, timedOut: false, stderr, stdout: '', ...extra });
  assert.equal(isInvalidGoSource(result('# example.com/fixture\n./value.go:7:14: invalid operation: s - n'), 'value.go'), true);
  assert.equal(isInvalidGoSource(result('go: write /tmp/build: no space left on device'), 'value.go'), false);
  assert.equal(isInvalidGoSource(result('# example.com/fixture\n./other.go:7:14: undefined: n'), 'value.go'), false);
  assert.equal(isInvalidGoSource(result('# example.com/fixture\n./value.go:7:14: invalid operation: s - n', { signal: 'SIGKILL' }), 'value.go'), false);
  assert.equal(isInvalidGoSource(result('# example.com/fixture\n./value.go:7:14: internal compiler error: panic'), 'value.go'), false);
});

test('Go process timeout and output cap terminate descendants without signaling unrelated processes', async (t) => {
  if (!['darwin', 'linux', 'freebsd', 'openbsd', 'netbsd'].includes(process.platform)) return t.skip('POSIX process group required');
  const root = project(t);
  const marker = join(root, 'descendant-marker');
  const unrelated = join(root, 'unrelated-marker');
  const unrelatedChild = await import('node:child_process').then(({ spawn }) => spawn(process.execPath,
    ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(unrelated)}, 'alive'), 400)`],
    { stdio: 'ignore' }));
  t.after(() => { try { unrelatedChild.kill('SIGKILL'); } catch {} });
  const descendant = `require('child_process').spawn(process.execPath, ['-e',
    ${JSON.stringify(`setInterval(() => require('fs').appendFileSync(${JSON.stringify(marker)}, '.'), 10)`) }],
    { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  const timed = await runGoProcess(process.execPath, ['-e', descendant], { root, env: process.env, timeoutMs: 250 });
  assert.equal(timed.timedOut, true);
  const before = readFileSync(marker, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(readFileSync(marker, 'utf8'), before);
  assert.equal(readFileSync(unrelated, 'utf8'), 'alive');

  const overflowMarker = join(root, 'overflow-marker');
  const overflowChild = `require('child_process').spawn(process.execPath, ['-e',
    ${JSON.stringify(`setInterval(() => require('fs').appendFileSync(${JSON.stringify(overflowMarker)}, '.'), 10)`) }],
    { stdio: 'inherit' }); setTimeout(() => process.stdout.write(Buffer.alloc(17 * 1024 * 1024)), 100); setInterval(() => {}, 1000);`;
  await assert.rejects(() => runGoProcess(process.execPath, ['-e', overflowChild],
    { root, env: process.env, timeoutMs: 5000 }), { code: 'output-limit' });
  const capBefore = readFileSync(overflowMarker, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(overflowMarker, 'utf8'), capBefore);
});
