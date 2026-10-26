// Scratch-only runtime call counters. No source contents or project paths are logged.
const fs = require('node:fs');
const trace = process.env.CUPEL_S26_TRACE;
if (!trace) throw new Error('CUPEL_S26_TRACE is required');
const append = fs.appendFileSync.bind(fs);
const record = name => append(trace, JSON.stringify({ pid: process.pid, name }) + '\n');
const vm = require('node:vm');
for (const name of ['createContext', 'runInContext', 'runInThisContext', 'compileFunction']) {
  const original = vm[name];
  vm[name] = function (...args) { record(`vm.${name}`); return original.apply(this, args); };
}
const cp = require('node:child_process');
const fork = cp.fork;
cp.fork = function (...args) { record('child_process.fork'); return fork.apply(this, args); };
const threads = require('node:worker_threads');
const Worker = threads.Worker;
threads.Worker = class S26ObservedWorker extends Worker {
  constructor(...args) { record('worker_threads.Worker'); super(...args); }
};
const asyncPrototype = Object.getPrototypeOf(async function () {});
const AsyncFunction = asyncPrototype.constructor;
Object.defineProperty(asyncPrototype, 'constructor', {
  configurable: true, writable: true,
  value: function (...args) { record('AsyncFunction'); return new AsyncFunction(...args); },
});
require('node:module').syncBuiltinESMExports();
record('preload-ready');
