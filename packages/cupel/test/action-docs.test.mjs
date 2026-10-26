import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bin = join(root, 'packages/cupel/bin/cupel.mjs');
const collector = join(root, 'docs/extending/demo/collector.mjs');
const call = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

test('extension examples validate and the external demo measures its one test', () => {
  const sample = call([bin, 'validate', 'docs/extending/example-input.json']);
  assert.equal(sample.status, 0, sample.stderr);
  const configDoc = readFileSync(join(root, 'docs/extending/config.md'), 'utf8');
  const config = JSON.parse(configDoc.match(/```json\n([\s\S]*?)\n```/)?.[1]);
  const work = mkdtempSync(join(tmpdir(), 'cupel-extension-demo-'));
  try {
    const configFile = join(work, 'cupel.json');
    writeFileSync(configFile, JSON.stringify(config));
    assert.equal(call([bin, 'validate', configFile]).status, 0);
    const out = join(work, 'input.json');
    const run = call([bin, 'report', '--config', 'docs/extending/demo/cupel.json', '--no-mutation', '--runs', '1', '--out', out]);
    assert.equal(run.status, 0, run.stderr);
    const input = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(input.tests.length, 1);
    assert.equal(input.tests[0].status, 'passed');
    assert.deepEqual(input.sources, {}, 'the demo must not invent coverage');
    assert.equal(call([bin, 'validate', out]).status, 0);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('status-only demo rejects a coverage recheck it cannot perform', () => {
  const run = call([collector, '--root', root, '--runs', '1', '--out', '/tmp/unused-cupel-demo.json', '--recheck', 'x']);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /cannot recheck coverage/);
});
