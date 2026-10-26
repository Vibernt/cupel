import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('diagnostic parent counts safe bytes and denies opaque content before read', t => {
  const root = mkdtempSync(join(tmpdir(), 's16-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, 'diagnostic.json');
  writeFileSync(join(root, 'safe.txt'), 'hello');
  writeFileSync(join(root, '.npmrc'), 'synthetic-only');
  const preload = resolve(import.meta.dirname, 'diagnostic-preload.cjs');
  const run = spawnSync(process.execPath, [`--require=${preload}`, '-e',
    "const fs=require('node:fs');fs.readFileSync('safe.txt');for(const read of [()=>fs.readFileSync('.npmrc'),()=>fs.readFile('.npmrc',()=>{})])try{read()}catch(e){if(e.message!=='opaque file read denied')process.exitCode=2}fs.promises.readFile('.npmrc').then(()=>process.exitCode=2,e=>{if(e.message!=='opaque file read denied')process.exitCode=2})"],
  { cwd: root, env: { PATH: process.env.PATH, S16_DIAG_ROOT: root,
    S16_DIAG_BASE_ROOT: root,
    S16_DIAG_PROFILE_ROOT: resolve(import.meta.dirname, '../s12b/node-profile'),
    S16_DIAG_COORD_ROOT: import.meta.dirname,
    S16_DIAG_PROJECT_ROOT: resolve(import.meta.dirname, '../../..'),
    S16_DIAG_REPORT: report }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const counts = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(counts.readBytes.headInventory, 5, JSON.stringify(counts));
  assert.equal(counts.opaqueReadDenied, 3);
  assert.equal(counts.unattributedFdReads, 0);
  assert.ok(!JSON.stringify(counts).includes('synthetic-only'));
  assert.ok(!JSON.stringify(counts).includes(root));
});
