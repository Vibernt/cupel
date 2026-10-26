import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criticalProfileSites } from '../src/pr/profiles/node/critical-sites.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';
const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function fixture(text = 'module.exports = value => value + 1;\n') {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-sites-'));
  mkdirSync(join(root, 'src'));
  const source = 'src/math.cjs';
  writeFileSync(join(root, source), text);
  const input = { sources: { [source]: { hash: sha(text), coverable: '1' } },
    tests: [{ id: 'tests/math.test.cjs::math', status: 'passed' }] };
  const manifest = { [source]: sha(text) };
  return { root, source, input, manifest,
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('critical site enumeration validates every native site and exact changed line', () => {
  const f = fixture();
  try {
    const options = { root: f.root, input: f.input, manifest: f.manifest,
      config: { tiers: { critical: [f.source] } }, nodePath };
    const full = criticalProfileSites(options);
    assert.equal(full.scope, 'full-critical-sources');
    assert.equal(full.sites.length, 1);
    assert.equal(full.sites[0].operator, 'arith');
    const changed = criticalProfileSites({ ...options, changed: { [f.source]: '1' } });
    assert.deepEqual(changed.sites, full.sites);
    assert.deepEqual(criticalProfileSites({ ...options,
      changed: { [f.source]: '2' } }).sites, []);
  } finally { f.close(); }
});

test('critical site budget and stale bytes refuse, with no sampled success', () => {
  const f = fixture('module.exports = value => value + 1 - 2;\n');
  try {
    const args = { root: f.root, input: f.input, manifest: f.manifest, nodePath,
      config: { tiers: { critical: [f.source] }, mutation: { maxMutants: 1 } } };
    assert.throws(() => criticalProfileSites(args), /valid sites exceed cap 1/);
    writeFileSync(join(f.root, f.source), 'module.exports = value => value + 2 - 2;\n');
    assert.throws(() => criticalProfileSites(args), /critical source changed/);
  } finally { f.close(); }
});

test('Node 22 critical site enumeration refuses before source analysis', () => {
  const f = fixture();
  try {
    assert.throws(() => criticalProfileSites({ root: f.root, input: f.input,
      manifest: f.manifest, config: { tiers: { critical: [f.source] } },
      nodePath: '/opt/homebrew/opt/node@22/bin/node' }),
    /require verified Node 26\.7\.0/);
  } finally { f.close(); }
});

test('native erasable TypeScript critical sites retain raw source identity', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-sites-ts-'));
  try {
    mkdirSync(join(root, 'src'));
    const source = 'src/auth.ts';
    const text = 'export const auth = (value: number): number => value + 1;\n';
    writeFileSync(join(root, source), text);
    const input = { sources: { [source]: { hash: sha(text), coverable: '1' } },
      tests: [{ id: 'tests/auth.test.mjs::auth', status: 'passed' }] };
    const result = criticalProfileSites({ root, input, manifest: { [source]: sha(text) },
      config: { tiers: { critical: [source] } }, nodePath });
    assert.ok(result.sites.some(site => site.operator === 'arith'));
    assert.ok(result.sites.every(site => site.source === source));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
