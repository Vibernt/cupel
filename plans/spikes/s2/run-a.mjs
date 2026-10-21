#!/usr/bin/env node
// S2 driver for method A: one process per test, selected with --test-name-pattern, coverage from NODE_V8_COVERAGE.
//
// Usage:
//   node plans/spikes/s2/run-a.mjs --root /abs/suite --out /abs/out-s2 [--reps 3] [--keep-raw 1] \
//     tests/a.test.mjs tests/b.test.mjs ...
//
// For each file:
//  1. `node <file>` once with the S2 reporter, to list its top-level tests (and as a timed direct run).
//  2. Per repeat, per top-level test: NODE_V8_COVERAGE=<dir> node --test-name-pattern="^<escaped name>$" <file>.
//     The run is direct (no `--test` parent process), so one process per test, plus any it spawns; spawned
//     node processes inherit NODE_V8_COVERAGE and write their own coverage files into the same directory.
//  3. Per repeat, one run whose pattern matches no test: the file's setup coverage (module load).
// After each run the coverage directory is turned into line sets (lines.mjs) and that processing is timed
// separately. Raw coverage JSON is kept for repeats <= --keep-raw (default 1) and deleted for the others.
// Writes <out>/a/r<rep>/<file>/<index>/{lines.json,tests.ndjson,log.txt} and <out>/a/timings.json.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timed, args, readNdjson } from './exec.mjs';
import { LineRule } from './lines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { reps: '3', 'keep-raw': '1' });
if (!opt.root || !opt.out || !opt._.length) {
  console.error('usage: node run-a.mjs --root <suite> --out <dir> [--reps 3] [--keep-raw 1] <test files>');
  process.exit(2);
}
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_V8_COVERAGE;
delete env.NODE_OPTIONS;
const rule = new LineRule(opt.root);
const reporter = (dir) => [`--test-reporter=${join(HERE, 'reporter.mjs')}`, `--test-reporter-destination=${join(dir, 'tests.ndjson')}`];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const NO_TEST = '(?!)'; // matches nothing: the run loads the file and runs no test

// 1. List the tests.
const lists = {};
const timings = [];
for (const file of opt._) {
  const dir = join(opt.out, 'a', 'list', basename(file));
  mkdirSync(dir, { recursive: true });
  const r = timed([process.execPath, ...reporter(dir), file], { cwd: opt.root, env, log: join(dir, 'log.txt') });
  const top = readNdjson(join(dir, 'tests.ndjson')).filter((x) => x.nesting === 0 && x.type !== 'suite');
  const names = top.map((x) => x.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  lists[file] = names;
  timings.push({ rep: 0, file, test: null, kind: 'list', ...r, tests: top.length, dupes });
  console.log(`${basename(file)}: ${names.length} top-level tests${dupes.length ? `, duplicate names: ${dupes.length}` : ''}`);
}

// 2 and 3. Per-test runs, and the no-test run.
for (let rep = 1; rep <= Number(opt.reps); rep++) {
  for (const file of opt._) {
    const jobs = [{ index: 'setup', test: null, pattern: NO_TEST }, ...lists[file].map((name, i) => ({ index: String(i).padStart(3, '0'), test: name, pattern: `^${escape(name)}$` }))];
    for (const job of jobs) {
      const dir = join(opt.out, 'a', `r${rep}`, basename(file), job.index);
      const cov = join(dir, 'v8');
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(cov, { recursive: true });
      const r = timed([process.execPath, `--test-name-pattern=${job.pattern}`, ...reporter(dir), file],
        { cwd: opt.root, env: { ...env, NODE_V8_COVERAGE: cov }, log: join(dir, 'log.txt') });
      const ran = readNdjson(join(dir, 'tests.ndjson')).filter((x) => x.nesting === 0 && !x.skip && x.type !== 'suite');
      // Processing: coverage files -> line sets (all processes of the run, the test process and any children).
      const p0 = process.hrtime.bigint();
      const covFiles = readdirSync(cov).filter((f) => f.startsWith('coverage-') && f.endsWith('.json'));
      const merged = new Map();
      const perProcess = [];
      let rawBytes = 0;
      for (const f of covFiles) {
        const text = readFileSync(join(cov, f), 'utf8');
        rawBytes += text.length;
        const sets = rule.lineSets(JSON.parse(text).result);
        let n = 0;
        for (const [p, ls] of sets) {
          n += ls.size;
          let m = merged.get(p);
          if (!m) merged.set(p, (m = new Set()));
          for (const l of ls) m.add(l);
        }
        perProcess.push({ file: f, lines: n });
      }
      const processMs = Number(process.hrtime.bigint() - p0) / 1e6;
      const lines = Object.fromEntries([...merged].sort().map(([p, ls]) => [p, [...ls].sort((a, b) => a - b)]));
      writeFileSync(join(dir, 'lines.json'), JSON.stringify({ file, test: job.test, processes: perProcess, lines }));
      if (rep > Number(opt['keep-raw'])) rmSync(cov, { recursive: true, force: true });
      const row = {
        rep, file, test: job.test, kind: job.test === null ? 'setup' : 'test', ...r, processMs, rawBytes,
        processes: covFiles.length, ran: ran.length, pass: ran.filter((x) => x.event === 'pass').length,
        ranNames: ran.map((x) => x.name),
      };
      timings.push(row);
      const bad = job.test === null ? row.ran !== 0 : row.ran !== 1 || row.pass !== 1;
      console.log(`r${rep} ${basename(file)} ${job.index} wall ${r.wallMs.toFixed(0).padStart(5)} ms cpu ${r.cpuMs.toFixed(0).padStart(5)} ms ` +
        `proc ${processMs.toFixed(0).padStart(4)} ms procs ${covFiles.length}${bad ? `  CHECK ran=${row.ran} pass=${row.pass}` : ''}`);
    }
  }
  writeFileSync(join(opt.out, 'a', 'timings.json'), JSON.stringify(timings, null, 1));
}
writeFileSync(join(opt.out, 'a', 'timings.json'), JSON.stringify(timings, null, 1));
writeFileSync(join(opt.out, 'a', 'lists.json'), JSON.stringify(lists, null, 1));
