import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('diagnostic preload counts the parent launch without changing its result', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s17-spawns-'));
  try {
    const file = join(root, 'counts.json');
    const code = "const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['--version'],{encoding:'utf8'});if(r.status)process.exit(r.status);";
    // The preload wraps asynchronous spawn. Exercise that exact API as well.
    const asyncCode = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['--version']);c.on('close',code=>process.exit(code));";
    const env = { ...process.env, CUPEL_S17_SPAWN_COUNTS: file };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--require', new URL('./diagnostic-spawns.cjs', import.meta.url).pathname,
      '-e', `${code}${asyncCode}`], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { test: 0, jest: 0, validity: 0, other: 1,
      projectSourceReadCalls: 0, projectSourceReadBytes: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('diagnostic preload counts guarded descriptor reads without recording paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s17-fd-'));
  try {
    mkdirSync(join(root, 'src'));
    const source = join(root, 'src', 'a.mjs');
    writeFileSync(source, '12345');
    const file = join(root, 'counts.json');
    const code = "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');fs.readFileSync(fd);fs.closeSync(fd);";
    const env = { ...process.env, CUPEL_S17_SPAWN_COUNTS: file, CUPEL_S17_PROJECT_ROOT: root };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--require', new URL('./diagnostic-spawns.cjs', import.meta.url).pathname,
      '-e', code, source], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { test: 0, jest: 0, validity: 0, other: 0,
      projectSourceReadCalls: 1, projectSourceReadBytes: 5 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
