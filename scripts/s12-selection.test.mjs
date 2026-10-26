import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { baseFiles, inject, writeFiles } from '../plans/spikes/s12/fixtures.mjs';
import { fileInventory, makeEvidence, select } from '../plans/spikes/s12/selection.mjs';

function fixture() {
  const root = mkdtempSync('/tmp/cupel-s12-test-');
  const base = join(root, 'base'); const head = join(root, 'head');
  writeFiles(base, baseFiles('node'));
  cpSync(base, head, { recursive: true });
  const hashes = fileInventory(base);
  const input = { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '26.7.0' },
    sources: Object.fromEntries(['src/core.mjs', 'src/setup.mjs', 'src/text.mjs'].map((path) => [path, { coverable: '1', hash: `sha256:${hashes[path]}` }])),
    tests: [
      { id: 'tests/core.test.mjs::plus', file: 'tests/core.test.mjs', name: 'plus', status: 'passed', tags: [] },
      { id: 'tests/setup.test.mjs::setup', file: 'tests/setup.test.mjs', name: 'setup', status: 'passed', tags: [] },
      { id: 'tests/critical.test.mjs::critical', file: 'tests/critical.test.mjs', name: 'critical', status: 'passed', tags: ['critical'] },
    ],
    coverage: { granularity: 'test', byTest: { 'tests/core.test.mjs::plus': { 'src/core.mjs': '1' } },
      byFile: {}, setup: { 'tests/setup.test.mjs': { 'src/setup.mjs': '1' } } } };
  const args = { baseRoot: base, runner: 'node', runtime: 'node test', config: { runner: 'node' } };
  const evidence = makeEvidence({ ...args, input });
  return { root, head, evidence, args };
}

test('selects full test files from source and setup coverage', () => {
  const f = fixture();
  try {
    inject(f.head, 'node', 'ordinary-source');
    const decision = select({ ...f.args, headRoot: f.head, evidence: f.evidence });
    assert.equal(decision.kind, 'selected');
    assert.deepEqual(decision.files, ['tests/core.test.mjs', 'tests/critical.test.mjs']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
  const g = fixture();
  try {
    inject(g.head, 'node', 'shared-setup');
    const decision = select({ ...g.args, headRoot: g.head, evidence: g.evidence });
    assert.equal(decision.kind, 'selected');
    assert.ok(decision.files.includes('tests/setup.test.mjs'));
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('new tests execute, non-code changes take the logged full route', () => {
  const f = fixture();
  try {
    inject(f.head, 'node', 'new-test');
    assert.ok(select({ ...f.args, headRoot: f.head, evidence: f.evidence }).files.includes('tests/new.test.mjs'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
  const g = fixture();
  try {
    inject(g.head, 'node', 'config-input');
    inject(g.head, 'node', 'new-test');
    const decision = select({ ...g.args, headRoot: g.head, evidence: g.evidence });
    assert.equal(decision.kind, 'full');
    assert.match(decision.reason, /non-code/);
    assert.ok(decision.files.includes('tests/new.test.mjs'));
  } finally { rmSync(g.root, { recursive: true, force: true }); }
});

test('stale and corrupt evidence, unknown source and critical removal refuse', () => {
  for (const fault of ['source-text-pin', 'critical-removed']) {
    const f = fixture();
    try {
      inject(f.head, 'node', fault);
      assert.equal(select({ ...f.args, headRoot: f.head, evidence: f.evidence }).kind, 'refuse');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = fixture();
  try {
    assert.equal(select({ ...f.args, headRoot: f.head, evidence: { ...f.evidence, identity: { ...f.evidence.identity, tree: 'bad' } } }).kind, 'refuse');
    assert.equal(select({ ...f.args, headRoot: f.head, evidence: { ...f.evidence, input: { ...f.evidence.input, tests: [] } } }).kind, 'refuse');
    assert.equal(select({ ...f.args, headRoot: f.head, evidence: f.evidence, runtime: 'other' }).kind, 'refuse');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('engine labels protect critical names and configured critical paths', () => {
  const f = fixture();
  try {
    const input = structuredClone(f.evidence.input);
    input.tests[0].name = 'reject forged token';
    const tierConfig = { tiers: { critical: ['tests/setup.test.mjs'] } };
    const evidence = makeEvidence({ ...f.args, input, tierConfig });
    assert.deepEqual(evidence.criticalFiles,
      ['tests/core.test.mjs', 'tests/critical.test.mjs', 'tests/setup.test.mjs']);
    const decision = select({ ...f.args, headRoot: f.head, evidence, tierConfig });
    assert.equal(decision.kind, 'selected');
    assert.deepEqual(decision.files, evidence.criticalFiles);
    assert.equal(select({ ...f.args, headRoot: f.head, evidence, tierConfig: {} }).kind, 'refuse');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unsupported source takes precedence over an accompanying non-code full route', () => {
  const f = fixture();
  try {
    inject(f.head, 'node', 'config-input');
    writeFiles(f.head, { 'src/new.mjs': 'export const newValue = 1;\n' });
    const decision = select({ ...f.args, headRoot: f.head, evidence: f.evidence });
    assert.equal(decision.kind, 'refuse');
    assert.match(decision.reason, /new, removed or renamed source/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
