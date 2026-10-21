#!/usr/bin/env node
// S4: run S3's mutation runner (plans/spikes/s3/run.mjs) end to end on a chosen set of test files.
//
// Usage:
//   node plans/spikes/s4/mutation.mjs --repo /abs/suite --out /abs/out-dir --config plans/spikes/s4/config.json \
//     [--jobs 6] [--files tests/a.test.mjs,tests/b.test.mjs | --files-from list.txt]
//
// Runs the phases select (only the given test files; all of tests/ when none are given), baseline, mutants,
// run (--stop-after-files 0: every selected file runs for every mutant, so per-test kills are complete),
// recheck (timeouts again, 2 processes, a longer limit) and report. The mutants are served in memory by S3's load
// hook; nothing in the suite is written. Then compare two runs with kills.mjs.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../s2/exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { jobs: '6' });
if (!opt.repo || !opt.out || !opt.config) { console.error('usage: node mutation.mjs --repo <suite> --out <dir> --config <json> [--files a,b | --files-from f]'); process.exit(2); }
const files = opt['files-from'] ? readFileSync(opt['files-from'], 'utf8').split('\n').filter(Boolean).join(',') : opt.files;
mkdirSync(opt.out, { recursive: true });
const runner = join(HERE, '..', 's3', 'run.mjs');
const base = ['--repo', opt.repo, '--out', opt.out, '--config', opt.config];
const phases = [
  ['select', '--jobs', opt.jobs, ...(files ? ['--test-files', files] : [])],
  ['baseline', '--jobs', opt.jobs],
  ['mutants'],
  ['run', '--jobs', opt.jobs, '--stop-after-files', '0'],
  ['recheck', '--jobs', '2', '--stop-after-files', '0'],
  ['report'],
];
const log = [];
for (const [phase, ...rest] of phases) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', runner, phase, ...base, ...rest], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28 });
  const tail = (r.stderr || '').split('\n').filter((l) => l.startsWith('[s3')).slice(-2).join('\n');
  console.log(`${phase}: exit ${r.status}, ${Math.round((Date.now() - t0) / 1000)} s${tail ? `\n${tail}` : ''}`);
  log.push({ phase, exit: r.status, ms: Date.now() - t0 });
  if (phase === 'report') writeFileSync(join(opt.out, 'report.txt'), r.stdout);
  if (r.status !== 0) { console.error(r.stderr.slice(-3000)); process.exit(1); }
}
writeFileSync(join(opt.out, 'phases.json'), JSON.stringify(log, null, 1));
