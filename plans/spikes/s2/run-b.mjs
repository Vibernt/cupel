#!/usr/bin/env node
// S2 driver for method B (in-process precise coverage at test boundaries), plus the plain baselines.
//
// Usage:
//   node plans/spikes/s2/run-b.mjs --root /abs/suite --out /abs/out-s2 [--reps 3] \
//     [--variants plain,direct,hooks,start-only,coverage] tests/a.test.mjs tests/b.test.mjs ...
//
// Variants, each run once per file per repeat (interleaved, so machine load spreads evenly):
//   direct      node <file>                                  (one process, no test runner parent)
//   plain       node --test <file>                           (the normal way; the baseline for overheads)
//   hooks       node --test --import hook.mjs <file>         CUPEL_S2_MODE=hooks: hooks only, no profiler
//   start-only  ... CUPEL_S2_MODE=start-only                 precise coverage on, taken once at exit
//   coverage    ... CUPEL_S2_MODE=coverage                   method B: a take at every test boundary
// Writes <out>/b/<variant>/r<rep>/<file>/ (reporter NDJSON, hook JSON, log) and <out>/b/timings.json.

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timed, args, readNdjson } from './exec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = args(process.argv.slice(2), { reps: '3', variants: 'direct,plain,hooks,start-only,coverage' });
if (!opt.root || !opt.out || !opt._.length) {
  console.error('usage: node run-b.mjs --root <suite> --out <dir> [--reps 3] [--variants ...] <test files>');
  process.exit(2);
}
const variants = opt.variants.split(',');
const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
delete env.NODE_V8_COVERAGE;
delete env.NODE_OPTIONS;

const timings = [];
for (let rep = 1; rep <= Number(opt.reps); rep++) {
  for (const file of opt._) {
    for (const v of variants) {
      const dir = join(opt.out, 'b', v, `r${rep}`, basename(file));
      mkdirSync(dir, { recursive: true });
      const reporter = [`--test-reporter=${join(HERE, 'reporter.mjs')}`, `--test-reporter-destination=${join(dir, 'tests.ndjson')}`];
      let argv;
      const e = { ...env, CUPEL_S2_OUT: dir, CUPEL_S2_ROOT: opt.root };
      if (v === 'direct') argv = [process.execPath, ...reporter, file];
      else if (v === 'plain') argv = [process.execPath, '--test', ...reporter, file];
      else {
        argv = [process.execPath, '--test', ...reporter, '--import', join(HERE, 'hook.mjs'), file];
        e.CUPEL_S2_MODE = v;
      }
      const r = timed(argv, { cwd: opt.root, env: e, log: join(dir, 'log.txt') });
      const results = readNdjson(join(dir, 'tests.ndjson'));
      const hookFile = readdirSync(dir).find((f) => f.startsWith('b-') && f.endsWith('.write.json'));
      const write = hookFile ? JSON.parse(readFileSync(join(dir, hookFile), 'utf8')) : null;
      const hookMain = hookFile ? JSON.parse(readFileSync(join(dir, hookFile.replace('.write.json', '.json')), 'utf8')) : null;
      const row = {
        rep, file, variant: v, ...r,
        tests: results.filter((x) => x.type !== 'suite').length,
        pass: results.filter((x) => x.event === 'pass' && x.type !== 'suite').length,
        fail: results.filter((x) => x.event === 'fail').length,
        takes: hookMain?.takes ?? null,
        takeMsTotal: hookMain?.takeMsTotal ?? null,
        writeMs: write?.writeMs ?? null,
        rawBytes: write?.bytes ?? null,
        inspectorUrl: hookMain ? hookMain.inspectorUrl : undefined,
      };
      timings.push(row);
      console.log(`r${rep} ${basename(file).padEnd(22)} ${v.padEnd(10)} wall ${r.wallMs.toFixed(0).padStart(6)} ms  cpu ${r.cpuMs.toFixed(0).padStart(6)} ms  ` +
        `tests ${row.pass}/${row.tests}${row.fail ? ` FAIL ${row.fail}` : ''}${row.takes != null ? `  takes ${row.takes} (${row.takeMsTotal.toFixed(0)} ms)` : ''}`);
    }
  }
}
mkdirSync(join(opt.out, 'b'), { recursive: true });
writeFileSync(join(opt.out, 'b', 'timings.json'), JSON.stringify(timings, null, 1));
