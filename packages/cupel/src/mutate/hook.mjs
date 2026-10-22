// Preload for mutant runs (K6, spike S3). Loaded with NODE_OPTIONS="--import=<file URL of this module>", so it also
// applies in child processes the tests start.
//
// CUPEL_MUTANT names a small JSON file { url, sourcePath, seen }. When the module at `url` (a file: URL of the real path; the
// query string is ignored) is loaded, the single mutated source is served in its place, in memory, and the process id is appended to
// `seen`, so the runner knows the mutant was loaded. The file on disk is never touched. Without CUPEL_MUTANT the
// hook serves nothing (baseline runs).
//
// CUPEL_MARKS names a file. In a `node --test` process, a root-level beforeEach and afterEach write
// "S <full test name>" and "E <full test name>" to it synchronously, so a run killed by its timeout still says which
// test was running (a synchronous infinite loop stops the reporter from hearing anything).

import { registerHooks } from 'node:module';
import { readFileSync, appendFileSync, openSync, writeSync } from 'node:fs';

const specPath = process.env.CUPEL_MUTANT;
if (specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  registerHooks({
    load(url, context, next) {
      if (url.split('?')[0].split('#')[0] === spec.url) {
        if (spec.seen) appendFileSync(spec.seen, `${process.pid}\n`);
        const original = next(url, context);
        return { ...original, source: readFileSync(spec.sourcePath, 'utf8'), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

const marks = process.env.CUPEL_MARKS;
if (marks && process.execArgv.includes('--test')) {
  const { beforeEach, afterEach } = await import('node:test');
  const fd = openSync(marks, 'a');
  const name = (t) => String(t.fullName ?? t.name).replace(/\n/g, ' ');
  beforeEach((t) => { writeSync(fd, `S ${name(t)}\n`); });
  afterEach((t) => { writeSync(fd, `E ${name(t)}\n`); });
}
