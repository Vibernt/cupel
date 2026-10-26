const Module = require('node:module');
const inspector = require('node:inspector');
const promises = require('node:inspector/promises');
const { deny } = require('./policy.cjs');
const blocked = action => function () { deny('forbidden-inspector', action); };

for (const [name, api] of [['inspector', inspector], ['inspector/promises', promises]]) {
  const Session = api.Session;
  if (typeof Session !== 'function') throw new Error(`${name} Session unavailable for guard`);
  for (const method of ['connect', 'connectToMainThread', 'post', 'disconnect']) {
    if (!Object.hasOwn(Session.prototype, method)) continue;
    Object.defineProperty(Session.prototype, method,
      { value: blocked(`${name}.Session.${method}`), configurable: false, writable: false });
  }
  for (const method of ['Session', 'open', 'close', 'url', 'waitForDebugger']) {
    if (typeof api[method] !== 'function') continue;
    Object.defineProperty(api, method,
      { value: blocked(`${name}.${method}`), configurable: false, writable: false });
  }
  Object.freeze(Session.prototype);
  Object.freeze(api);
}
if (typeof process._debugProcess !== 'function' || typeof process.kill !== 'function' ||
    typeof process._kill !== 'function') throw new Error('required process debug/signal guard unavailable');
for (const name of ['_debugProcess', '_debugEnd', 'kill', '_kill']) {
  if (typeof process[name] === 'function') Object.defineProperty(process, name,
    { value: blocked(`process.${name}`), configurable: false, writable: false });
}
const debugPort = process.debugPort;
Object.defineProperty(process, 'debugPort', { configurable: false,
  get() { return debugPort; }, set: blocked('process.debugPort') });
const emit = process.emit;
Object.defineProperty(process, 'emit', { configurable: false, writable: false,
  value: function (event, ...args) {
    if (/^SIG[A-Z0-9]+$/.test(String(event))) deny('forbidden-inspector', `process.emit:${event}`);
    return emit.call(this, event, ...args);
  } });
Module.syncBuiltinESMExports();
