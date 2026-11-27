// Preload for mutant runs (K6, spike S3). Loaded with NODE_OPTIONS="--import=<file URL of this module>", so it also
// applies in child processes the tests start. The runner puts it first in NODE_OPTIONS, so its hooks register before
// a loader the project sets up there or on the command line (for example `--import tsx`), and sit inside it.
//
// CUPEL_MUTANT names a small JSON file { url, sourcePath, seen, mark? }. When the module at `url` (a file: URL of the
// real path; the query string is ignored) is loaded, the single mutated source is served in its place, in memory, and
// the process id is appended to `seen`, so the runner knows the mutant was loaded. The file on disk is never touched.
// Without CUPEL_MUTANT the hooks serve nothing, but they are registered all the same (baseline runs), so a test that
// the hooks themselves break fails unmutated, and its failure can never be taken for a catch.
//
// JSX (CUPEL_JSX_HOOK=1, a session with JSX faults): a loader the project registered with `module.register` runs
// below every `registerHooks` hook, so a fault served here would bypass it and reach V8 untransformed. hook-jsx.mjs
// is therefore registered too, as the innermost async hook, and serves the fault there, below the project's loader.
// A JSX mutant's text carries a run proof (`mark`, jsx-mark.mjs); when the text coming up from the inner hooks has
// it, it already holds the fault (transformed or not) and is passed on unchanged.
//
// CUPEL_MARKS names a file. In a `node --test` process, a root-level beforeEach and afterEach write
// "S <full test name>" and "E <full test name>" to it synchronously, so a run killed by its timeout still says which
// test was running (a synchronous infinite loop stops the reporter from hearing anything).

import { register, registerHooks } from 'node:module';
import { readFileSync, appendFileSync, openSync, writeSync } from 'node:fs';

const specPath = process.env.CUPEL_MUTANT;
const spec = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : null;
const isMutant = (url) => spec !== null && url.split('?')[0].split('#')[0] === spec.url;
const text = (source) => (typeof source === 'string' ? source : source == null ? '' : new TextDecoder().decode(source));
if (process.env.CUPEL_JSX_HOOK === '1') {
  register(new URL('./hook-jsx.mjs', import.meta.url), { data: spec?.mark ? { url: spec.url, sourcePath: spec.sourcePath } : null });
}
registerHooks({
  load(url, context, next) {
    if (!isMutant(url)) return next(url, context);
    if (spec.seen) appendFileSync(spec.seen, `${process.pid}\n`);
    const original = next(url, context);
    if (spec.mark && text(original.source).includes(spec.mark)) return original;
    return { ...original, source: readFileSync(spec.sourcePath, 'utf8'), shortCircuit: true };
  },
});

const marks = process.env.CUPEL_MARKS;
if (marks && process.execArgv.includes('--test')) {
  const { beforeEach, afterEach } = await import('node:test');
  const fd = openSync(marks, 'a');
  const name = (t) => String(t.fullName ?? t.name).replace(/\n/g, ' ');
  beforeEach((t) => { writeSync(fd, `S ${name(t)}\n`); });
  afterEach((t) => { writeSync(fd, `E ${name(t)}\n`); });
}
