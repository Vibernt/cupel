import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeclaredNodeProfileConfig,
  assertSupportedNodeProfileConfig } from '../src/pr/policy.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('Node profile refuses ignored runners, command, collector and mutation switches', () => {
  for (const config of [
    { runners: { node: {}, jest: {} } },
    { runners: { node: { command: 'node --test' } } },
    { runners: { node: { collector: 'custom' } } },
    { runners: { node: { prepare: 'build' } } },
    { runners: { node: { env: { SECRET: 'x' } } } },
    { runners: { node: { project: 'wrong' } } },
    { mutation: { critical: false } },
    { mutation: { changedLines: false } },
    { mutation: { targeted: false } },
  ]) assert.throws(() => assertSupportedNodeProfileConfig(config), /refuses/);
  assert.throws(() => assertSupportedNodeProfileConfig({ mystery: true }), /schema invalid/);
  assert.doesNotThrow(() => assertSupportedNodeProfileConfig({ runners: {
    node: { tests: 'tests\/**\/*.test.cjs' } } }));
});

test('production config must equal the tracked declared bytes', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-policy-'));
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.cjs' } } };
    const text = `${JSON.stringify(config)}\n`;
    writeFileSync(join(root, 'cupel.json'), text);
    const manifest = { 'cupel.json': sha(text) };
    assert.doesNotThrow(() => assertDeclaredNodeProfileConfig(root, manifest, config));
    assert.throws(() => assertDeclaredNodeProfileConfig(root, manifest, {}), /differs/);
    assert.throws(() => assertDeclaredNodeProfileConfig(root, {}, config), /no declared/);
    writeFileSync(join(root, 'cupel.json'), `${text} `);
    assert.throws(() => assertDeclaredNodeProfileConfig(root, manifest, config), /bytes changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
