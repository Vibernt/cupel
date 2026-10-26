import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectNodeProfileHead } from '../src/pr/selection.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-selection-'));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
  const files = { 'src/auth.cjs': 'module.exports = value => value + 1;\n',
    'tests/a.test.cjs': "const {test}=require('node:test');test('a [critical]',()=>{});\n",
    'tests/b.test.cjs': "const {test}=require('node:test');test('b',()=>{});\n",
    'README.md': 'README old\n' };
  for (const [path, value] of Object.entries(files)) writeFileSync(join(root, path), value);
  const manifest = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, value]) => [path, sha(value)]));
  const input = { spec: 'cupel-spec/1', kind: 'input',
    runtime: { name: 'node', version: '26.7.0' },
    sources: { 'src/auth.cjs': { hash: manifest['src/auth.cjs'], coverable: '1' } },
    tests: [
      { id: 'tests/a.test.cjs::a [critical]', file: 'tests/a.test.cjs',
        name: 'a [critical]', tags: ['critical'], status: 'passed' },
      { id: 'tests/b.test.cjs::b', file: 'tests/b.test.cjs', name: 'b', status: 'passed' },
    ], coverage: { granularity: 'test',
      byTest: { 'tests/a.test.cjs::a [critical]': { 'src/auth.cjs': '1' },
        'tests/b.test.cjs::b': {} },
      setup: { 'tests/a.test.cjs': {}, 'tests/b.test.cjs': {} } } };
  const obs = { imports: [], reads: [], probes: [], directories: [], writes: [], filesystemEvents: [] };
  const baseline = { privacyPolicy: 'strict-v1', git: {
    inputManifest: manifest, opaqueRootNpmrc: 'absent', opaqueGit: null },
    config: { runners: { node: { tests: 'tests/**/*.test.cjs' } } },
    collection: { mode: 'full', fullFiles: ['tests/a.test.cjs', 'tests/b.test.cjs'],
      input, observations: {
        'tests/a.test.cjs': { ...obs, imports: ['src/auth.cjs'] },
        'tests/b.test.cjs': { ...obs, probes: ['README.md'], filesystemEvents: [
          { channel: 'probes', path: 'README.md', operation: 'statSync', origin: 'application' }] },
      } } };
  return { root, baseline,
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('changed source selects coverage owner and conservative application observer', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src/auth.cjs'), 'module.exports = value => value + 2;\n');
    const result = selectNodeProfileHead(f);
    assert.equal(result.route, 'selected');
    assert.deepEqual(result.files, ['tests/a.test.cjs', 'tests/b.test.cjs']);
    assert.deepEqual(result.changedSources, ['src/auth.cjs']);
    assert.match(result.headInventoryHash, /^sha256:[0-9a-f]{64}$/);
  } finally { f.close(); }
});

test('explicit opaque selection preserves presence and does not include .npmrc in changed paths', () => {
  const f = fixture();
  try {
    f.baseline.privacyPolicy = 'express-root-npmrc-opaque-v1';
    f.baseline.git.opaqueRootNpmrc = 'regular';
    f.baseline.git.opaqueGit = { path: '.npmrc', mode: '100644', oid: 'a'.repeat(40) };
    writeFileSync(join(f.root, '.npmrc'), 'synthetic-test-value\n');
    const result = selectNodeProfileHead(f);
    assert.deepEqual(result.changed, []);
    assert.equal(result.route, 'selected');
    rmSync(join(f.root, '.npmrc'));
    assert.throws(() => selectNodeProfileHead(f), /opaque root presence changed/);
  } finally { f.close(); }
});

test('changed critical test is selected for later identity verification; noncode takes profile-full', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'tests/a.test.cjs'),
      "const {test}=require('node:test');test('a changed [critical]',()=>{});\n");
    assert.deepEqual(selectNodeProfileHead(f).changedCriticalTests, ['tests/a.test.cjs']);
    writeFileSync(join(f.root, 'README.md'), 'README new\n');
    const result = selectNodeProfileHead(f);
    assert.equal(result.route, 'profile-full');
    assert.deepEqual(result.files, ['tests/a.test.cjs', 'tests/b.test.cjs']);
  } finally { f.close(); }
});

test('changed configuration, unknown code and private paths refuse', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'package.json'), '{}\n');
    assert.throws(() => selectNodeProfileHead(f), /changed runner configuration/);
    rmSync(join(f.root, 'package.json'));
    writeFileSync(join(f.root, 'helper.mjs'), 'export default 1;\n');
    assert.throws(() => selectNodeProfileHead(f), /unsupported changed code path/);
    rmSync(join(f.root, 'helper.mjs'));
    writeFileSync(join(f.root, '.env'), 'SECRET=never-print\n');
    assert.throws(() => selectNodeProfileHead(f), /private input path/);
  } finally { f.close(); }
});
