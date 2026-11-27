// Preload for mutant runs (K6, spike S3). Loaded with NODE_OPTIONS="--import=<file URL of this module>", so it also
// applies in child processes the tests start. The runner puts it first in NODE_OPTIONS, so its hooks register before
// a loader the project sets up there, on the command line or in its test files, and sit inside it.
//
// CUPEL_MUTANT names a small JSON file { url, sourcePath, seen, mark? }. When the module at `url` (a file: URL of the
// real path; the query string is ignored) is loaded, the single mutated source is served in its place, in memory. The
// file on disk is never touched. Without CUPEL_MUTANT the hooks serve nothing, but they are registered all the same
// (baseline runs), so a test the hooks themselves break fails unmutated and its failure is never taken for a catch.
//
// Lines appended to `seen`, one per event, so the runner can tell whether the served fault ran:
//   L <pid>  the module was loaded through the hooks (a mutant served or attempted);
//   U <pid>  a loader below this hook changed the file's text, or a loader's own handler may ignore what is served:
//            serving here would skip it, so what runs is not the fault;
//   B <pid>  CommonJS compiled the file from text without the run proof: a loader read the file itself.
// A marked mutant (`mark`, jsx-mark.mjs) appends `<mark> <pid>` to its own file each time its code runs.
//
// Loaders. A loader the project registers with `module.register` runs below every `registerHooks` hook, so a fault
// served here would bypass it. When the project first calls `module.register`, hook-inner.mjs is registered just
// before it, as the innermost async hook, and serves marked mutants there, below the project's loader. Nothing is
// registered when the project registers no async hook, so no process gets hooks or warnings it would not have had.
// CUPEL_LOADERS names a file where each process notes the loaders it sees (`register`, `registerHooks`,
// `loader-flag`, `preload`, `extensions`): the runner marks every fault once a loader is in play.
//
// CUPEL_MARKS names a file. In a `node --test` process, a root-level beforeEach and afterEach write
// "S <full test name>" and "E <full test name>" to it synchronously, so a run killed by its timeout still says which
// test was running (a synchronous infinite loop stops the reporter from hearing anything).

import Module, { syncBuiltinESMExports } from 'node:module';
import { readFileSync, appendFileSync, openSync, writeSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchLoaders } from '../collect/node/loader-watch.mjs';

const SELF = import.meta.url;
const specPath = process.env.CUPEL_MUTANT;
const spec = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : null;
const target = spec ? fileURLToPath(spec.url) : null;
const isMutant = (url) => spec !== null && url.split('?')[0].split('#')[0] === spec.url;
const text = (source) => (typeof source === 'string' ? source : source == null ? '' : new TextDecoder().decode(source));
// A leading byte-order mark: TextDecoder drops it, readFileSync keeps it, V8 runs ESM without it. Compare without.
const unBom = (value) => (value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);
const note = (kind) => { if (spec?.seen) appendFileSync(spec.seen, `${kind} ${process.pid}\n`); };
const loaderLog = process.env.CUPEL_LOADERS;
const noted = new Set();
const noteLoader = (kind) => {
  if (!loaderLog || noted.has(kind)) return;
  noted.add(kind);
  try { appendFileSync(loaderLog, `${kind} ${process.pid}\n`); } catch { /* never break the test */ }
};

// Loaders set up on the command line or in NODE_OPTIONS. `--loader` hooks register before this module runs, below
// it, out of reach of the inner hook: a fault served here would skip them.
const words = [...process.execArgv, ...String(process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
const loaderFlag = words.some((w) => /^--(experimental-)?loader(=|$)/.test(w));
if (loaderFlag) noteLoader('loader-flag');
for (let i = 0; i < words.length; i++) {
  const m = /^(--import|--require|-r)(?:=(.*))?$/.exec(words[i]);
  if (!m) continue;
  const value = m[2] ?? words[i + 1] ?? '';
  if (value !== SELF) noteLoader('preload');
}
const extensions = { ...Module._extensions };
// A handler set and undone before exit still ran: note it as it happens.
watchLoaders(Module, () => noteLoader('extensions'));

let inner = false;
const register = Module.register;
if (typeof register === 'function') {
  Module.register = function cupelRegister(...args) {
    noteLoader('register');
    if (!inner) {
      inner = true;
      register.call(this, new URL('./hook-inner.mjs', SELF), { data: spec?.mark ? { url: spec.url, sourcePath: spec.sourcePath } : null });
    }
    return register.apply(this, args);
  };
}
const registerHooks = Module.registerHooks;
let disk;
registerHooks.call(Module, {
  load(url, context, next) {
    if (!isMutant(url)) return next(url, context);
    note('L');
    const original = next(url, context);
    const below = original.source == null ? null : text(original.source);
    if (spec.mark && below?.includes(spec.mark)) return original; // served beneath the loader and passed up
    // Text from below that is not the file's own bytes: a loader below this hook (registered from a --require
    // preload, a --loader flag, or an async loader the inner hook did not reach) changed it, and serving here would
    // skip that loader. A loader's own handler for this extension may also ignore what is served (unmarked faults
    // cannot show it ran). Either way what runs is not the fault, so say so.
    disk ??= readFileSync(target, 'utf8');
    const replaced = Module._extensions[extname(target)] !== extensions[extname(target)];
    if ((below !== null && unBom(below) !== unBom(disk)) || (!spec.mark && replaced)) {
      note('U');
      return original;
    }
    return { ...original, source: readFileSync(spec.sourcePath, 'utf8'), shortCircuit: true };
  },
});
Module.registerHooks = function cupelRegisterHooks(...args) {
  noteLoader('registerHooks');
  return registerHooks.apply(this, args);
};
if (spec?.mark) {
  // A loader's CommonJS handler that reads the file itself (tsx, a require cache) compiles the original: say so.
  const compile = Module.prototype._compile;
  Module.prototype._compile = function cupelCompile(content, filename, ...rest) {
    if (filename === target && !text(content).includes(spec.mark)) note('B');
    return compile.call(this, content, filename, ...rest);
  };
}
syncBuiltinESMExports();
process.on('exit', () => {
  for (const [ext, handler] of Object.entries(Module._extensions)) if (handler !== extensions[ext]) noteLoader('extensions');
});

const marks = process.env.CUPEL_MARKS;
if (marks && process.execArgv.includes('--test')) {
  const { beforeEach, afterEach } = await import('node:test');
  const fd = openSync(marks, 'a');
  const name = (t) => String(t.fullName ?? t.name).replace(/\n/g, ' ');
  beforeEach((t) => { writeSync(fd, `S ${name(t)}\n`); });
  afterEach((t) => { writeSync(fd, `E ${name(t)}\n`); });
}
