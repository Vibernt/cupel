#!/usr/bin/env node
// S4: re-run chosen mutants against one test file several times, to tell a real kill from a flaky failure.
//
// Usage:
//   node plans/spikes/s4/rerun.mjs --repo /abs/suite --run /abs/out-s4/mutx-after-suite --file tests/x.test.mjs \
//     [--reps 3] [--baseline] <mutant id> [<mutant id> ...]
//
// Takes each mutant from <run>/mutants.json, serves it in memory with S3's hook (plans/spikes/s3/hook.mjs) and runs
// `node --test --test-isolation=none` on the file with S3's reporter, --reps times, one run at a time. With
// --baseline it also runs the file unmutated --reps times. Prints the failing tests of every run.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMutant } from '../s3/mutate.mjs';
import { args } from '../s2/exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { reps: '3' });
if (!opt.repo || !opt.run || !opt.file) { console.error('usage: node rerun.mjs --repo <suite> --run <run dir> --file <test file> [--reps n] [--baseline] <ids>'); process.exit(2); }
const { modules } = JSON.parse(readFileSync(join(opt.run, 'mutants.json'), 'utf8'));
const all = new Map(Object.values(modules).flatMap((m) => m.mutants).map((m) => [m.id, m]));
const work = mkdtempSync(join(tmpdir(), 's4-rerun-'));

function once(specPath) {
  const env = { ...process.env, NODE_OPTIONS: `--import ${join(HERE, '..', 's3', 'hook.mjs')}`, CUPEL_MUTANT: specPath || '' };
  delete env.NODE_V8_COVERAGE;
  const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', `--test-reporter=${join(HERE, '..', 's3', 'reporter.mjs')}`, opt.file], { cwd: opt.repo, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  const tests = r.stdout.split('\n').filter((l) => l.startsWith('{"s"')).map((l) => JSON.parse(l));
  return { code: r.status, tests: tests.length, failed: tests.filter((t) => t.s === 'fail').map((t) => `${t.t}: ${t.e}`) };
}

// args() reads `--baseline <id>` as a value: give the id back to the list.
if (typeof opt.baseline === 'string') opt._.unshift(opt.baseline);
const reps = Number(opt.reps);
if (opt.baseline) for (let i = 1; i <= reps; i++) {
  const r = once(null);
  console.log(`baseline r${i}: exit ${r.code}, ${r.tests} tests, failed ${r.failed.length}${r.failed.length ? `: ${r.failed.join(' | ').slice(0, 300)}` : ''}`);
}
for (const id of opt._) {
  const m = all.get(id);
  if (!m) { console.log(`${id}: not in ${opt.run}`); continue; }
  const spec = join(work, 'spec.json');
  writeFileSync(spec, JSON.stringify({ url: m.url, source: applyMutant(readFileSync(join(opt.repo, m.file), 'utf8'), m), seen: join(work, 'seen') }));
  for (let i = 1; i <= reps; i++) {
    const r = once(spec);
    console.log(`${id} r${i}: exit ${r.code}, ${r.tests} tests, failed ${r.failed.length}${r.failed.length ? `: ${r.failed.join(' | ').slice(0, 300)}` : ''}`);
  }
}
