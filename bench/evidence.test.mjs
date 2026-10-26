import test from 'node:test';
import assert from 'node:assert/strict';
import { reportInventory, goBaselineInventory, auditComparison, mutationEvidence } from './evidence.mjs';

const identity = { candidateRevision: 'a', cupelRevision: 'b', configHash: 'c', image: 'image', imageId: 'sha256:d', runtime: 'go1.2',
  candidateDirty: false, cupelDirty: false };
const inventory = { count: 2, idHash: 'x', idScheme: 'same', runnerSet: ['go'] };
const baseline = { status: 'ok', identity, runnerSet: ['go'], runs: [
  { counts: { passed: 2, failed: 0, skipped: 0 }, inventory },
  { counts: { passed: 2, failed: 0, skipped: 0 }, inventory },
] };
const report = { status: 'ok', identity, collectionInventory: inventory, fullInventory: inventory };

test('comparison needs matching identities, runner sets, test IDs and counts', () => {
  assert.equal(auditComparison(baseline, report).verdict, 'verified');
  assert.match(auditComparison(baseline, { ...report, collectionInventory: { ...inventory, count: 3 } }).reasons[0], /counts/);
  assert.equal(auditComparison(baseline, { ...report, identity: { ...identity, configHash: 'other' } }).verdict, 'invalid');
  assert.equal(auditComparison(baseline, { ...report, collectionInventory: { ...inventory, runnerSet: ['go', 'cargo'] } }).verdict, 'invalid');
  assert.equal(auditComparison(baseline, { ...report, fullInventory: { ...inventory, idHash: 'other' } }).verdict, 'invalid');
  assert.equal(auditComparison({ ...baseline, runs: baseline.runs.map((run) => ({ ...run, inventory: { ...inventory, count: 1 } })) }, report).verdict, 'invalid');
});

test('unknown historical provenance cannot yield overhead, even with equal counts', () => {
  const oldBaseline = { status: 'ok', runs: [{ counts: { passed: 2, failed: 0, skipped: 0 } }] };
  const oldReport = { status: 'ok', collectedTests: 2 };
  assert.equal(auditComparison(oldBaseline, oldReport).verdict, 'unverified');
  assert.equal(auditComparison(oldBaseline, { ...oldReport, collectedTests: 3 }).verdict, 'invalid');
  assert.equal(auditComparison({ ...baseline, runnerSet: null }, report).verdict, 'unverified');
  assert.equal(auditComparison({ ...baseline, runs: baseline.runs.map(({ inventory: ignored, ...run }) => run) }, report).verdict, 'unverified');
});

test('report inventory hashes exact IDs and records explicit runner counts', () => {
  const first = reportInventory({ tests: [{ id: 'b', runner: 'go' }, { id: 'a', runner: 'cargo' }] });
  const second = reportInventory({ tests: [{ id: 'a', runner: 'cargo' }, { id: 'b', runner: 'go' }] });
  assert.equal(first.idHash, second.idHash);
  assert.notEqual(first.idHash, reportInventory({ tests: [{ id: 'a', runner: 'go' }, { id: 'b', runner: 'cargo' }] }).idHash);
  assert.deepEqual(first.runners, { go: 1, cargo: 1 });
  assert.throws(() => reportInventory({ tests: [{ id: 'a' }, { id: 'a' }] }), /duplicate/);
  assert.deepEqual(reportInventory({ tests: [{ id: 'a' }] }).runners, { unspecified: 1 });
});

test('Go event inventory retains package and subtest IDs without inventing file IDs', () => {
  const output = ['{"Action":"pass","Package":"p/a","Test":"TestA"}',
    '{"Action":"pass","Package":"p/a","Test":"TestA/sub"}'].join('\n');
  assert.equal(goBaselineInventory(output).count, 2);
  assert.equal(goBaselineInventory(output).idScheme, 'go-package-test');
});

test('mutation evidence separates an empty sample from absent evidence', () => {
  assert.equal(mutationEvidence({}), null);
  assert.deepEqual(mutationEvidence({ mutation: { mutants: [] } }).counts,
    { killed: 0, timeout: 0, survived: 0, 'no-coverage': 0, error: 0 });
  assert.throws(() => mutationEvidence({ mutation: { mutants: [{ status: 'mystery' }] } }), /unknown/);
});
