#!/usr/bin/env node
// S2 attribution demo: a tiny synthetic suite that shows how method B (hook.mjs) attributes coverage for file
// hooks, nested subtests, concurrent subtests, async work that outlives its test, and child processes.
//
// Usage:
//   node plans/spikes/s2/demo-attribution.mjs [--keep]
// Writes a temporary suite (src/lib.mjs, sample.test.mjs) under the OS temp directory, runs it with
// `node --test --import hook.mjs`, and prints one line per segment: the checkpoint, who owns it, and which
// src functions ran in it. --keep leaves the temporary directory in place.

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-s2-demo-')));
mkdirSync(join(root, 'src'));
const fns = ['load', 'fileBefore', 'fileBeforeEach', 'fileAfterEach', 'one', 'leaked', 'parentOwn', 'childA', 'childB', 'leaf', 'c1', 'c2'];
writeFileSync(join(root, 'src', 'lib.mjs'), `export const loaded = load();\n${fns.map((f) => `export function ${f}() { return 1; }`).join('\n')}\n`);
writeFileSync(join(root, 'sample.test.mjs'), `import test, { before, beforeEach, afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as L from './src/lib.mjs';
before(() => L.fileBefore());
beforeEach(() => L.fileBeforeEach());
afterEach(() => L.fileAfterEach());
test('one', () => { L.one(); setTimeout(() => L.leaked(), 5); });          // leaves a timer behind
test('parent', async (t) => {
  L.parentOwn();
  await new Promise((r) => setTimeout(r, 20));                             // the leaked timer fires in here
  await t.test('child a', () => L.childA());
  await t.test('child b', () => L.childB());
});
describe('suite', () => { it('leaf', () => { L.leaf(); spawnSync(process.execPath, ['-e', '1']); }); });
test('conc', { concurrency: true }, async (t) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([t.test('c1', async () => { await sleep(20); L.c1(); }), t.test('c2', async () => { await sleep(10); L.c2(); })]);
});
`);
const out = join(root, 'out');
const r = spawnSync(process.execPath, ['--test', '--test-reporter=dot', '--import', join(HERE, 'hook.mjs'), 'sample.test.mjs'],
  { cwd: root, env: { ...process.env, CUPEL_S2_OUT: out, CUPEL_S2_ROOT: root }, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
const f = readdirSync(out).find((x) => x.startsWith('b-') && !x.endsWith('.write.json'));
const d = JSON.parse(readFileSync(join(out, f), 'utf8'));
console.log(`node ${d.node}, inspector.url() = ${d.inspectorUrl} (no port), ${d.takes} takes`);
console.log('seq checkpoint  kind     owners                         src functions run in the segment');
for (const s of d.segments) {
  const ran = s.scripts.flatMap((sc) => sc.functions.filter((fn) => fn.ranges.some((x) => x.count > 0)).map((fn) => fn.functionName || '(module)'));
  console.log(`${String(s.seq).padStart(3)} ${s.label.padEnd(10)} ${s.kind.padEnd(8)} ${(s.owners.join(' + ') + (s.shared ? ' [shared]' : '')).padEnd(30)} ${ran.join(', ')}${s.spawned.length ? `   spawned: ${s.spawned.join(', ')}` : ''}`);
}
if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true });
else console.log(`kept ${root}`);
