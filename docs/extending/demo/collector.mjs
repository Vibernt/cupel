#!/usr/bin/env node
// Executable status-only external collector example. It intentionally claims no coverage.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const file = 'docs/extending/demo/tests/math.test.mjs';
const id = `${file}::adds [critical]`;
const value = (flag) => {
  const at = process.argv.indexOf(flag);
  if (at < 0 || at + 1 >= process.argv.length) throw new Error(`missing ${flag}`);
  return process.argv[at + 1];
};

function main() {
  const root = value('--root');
  const out = value('--out');
  const runs = Number(value('--runs'));
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('--runs must be an integer from 1 to 100');
  if (process.argv.includes('--recheck')) throw new Error('this status-only example cannot recheck coverage');
  const statuses = [];
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST_')) delete env[name];
  for (let i = 0; i < runs; i++) {
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (run.error || run.signal) throw new Error(`runner unavailable: ${run.error?.message ?? run.signal}`);
    const text = run.stdout;
    if (!/^# tests 1$/m.test(text) || !/^# (?:pass [01]|fail [01])$/m.test(text)) {
      throw new Error('runner did not report the expected single test');
    }
    if (run.status === 0 && /^# pass 1$/m.test(text) && /^# fail 0$/m.test(text)) statuses.push('passed');
    else if (run.status === 1 && /^# fail 1$/m.test(text)) statuses.push('failed');
    else throw new Error(`runner ended unexpectedly: ${run.status}`);
  }
  const input = {
    spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: process.versions.node },
    sources: {},
    tests: [{ id, file, name: 'adds [critical]', tags: ['critical'],
      status: statuses.includes('failed') ? 'failed' : 'passed', runStatuses: statuses }],
    coverage: { granularity: 'file', byFile: {} },
  };
  writeFileSync(out, `${JSON.stringify(input, null, 2)}\n`);
}

try { main(); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 3; }
