'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');

const givenRoot = process.env.S16_DIAG_ROOT;
const givenBaseRoot = process.env.S16_DIAG_BASE_ROOT;
const givenProfile = process.env.S16_DIAG_PROFILE_ROOT;
const givenCoordinator = process.env.S16_DIAG_COORD_ROOT;
const givenProject = process.env.S16_DIAG_PROJECT_ROOT;
const report = process.env.S16_DIAG_REPORT;
if (![givenRoot, givenBaseRoot, givenProfile, givenCoordinator, givenProject, report]
  .every(value => value && path.isAbsolute(value)))
  throw new Error('S16 diagnostic paths must be explicit and absolute');
const root = fs.realpathSync(givenRoot);
const baseRoot = fs.realpathSync(givenBaseRoot);
const profile = fs.realpathSync(givenProfile);
const coordinator = fs.realpathSync(givenCoordinator);
const project = fs.realpathSync(givenProject);

const original = {
  readFileSync: fs.readFileSync,
  readFile: fs.readFile,
  openSync: fs.openSync,
  open: fs.open,
  createReadStream: fs.createReadStream,
  readdirSync: fs.readdirSync,
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  realpathSync: fs.realpathSync,
  writeFileSync: fs.writeFileSync,
  promiseReadFile: fs.promises.readFile.bind(fs.promises),
  promiseOpen: fs.promises.open.bind(fs.promises),
  promiseReaddir: fs.promises.readdir.bind(fs.promises),
  promiseLstat: fs.promises.lstat.bind(fs.promises),
  promiseStat: fs.promises.stat.bind(fs.promises),
  promiseRealpath: fs.promises.realpath.bind(fs.promises),
};
let started = process.hrtime.bigint();
let cpuStarted = process.cpuUsage();
const blank = () => ({ calls: {}, readBytes: {}, opaqueReadDenied: 0,
  unattributedFdReads: 0 });
let counts = blank();
let frozen = null;
const inside = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);
const name = value => {
  if (typeof value === 'number') return null;
  if (value instanceof URL) return path.resolve(fileURLToPath(value));
  if (typeof value === 'string' || Buffer.isBuffer(value)) return path.resolve(String(value));
  return null;
};
const opaque = value => [root, baseRoot].some(dir => name(value) === path.join(dir, '.npmrc'));
const repoBucket = (file, dir, label) => {
  if (file === path.join(dir, 'package-lock.json')) return `${label}Lockfile`;
  if (inside(file, path.join(dir, 'node_modules'))) return `${label}Dependencies`;
  return `${label}Inventory`;
};
const bucket = value => {
  const file = name(value);
  if (!file) return 'unattributed';
  if (inside(file, root)) return repoBucket(file, root, 'head');
  if (inside(file, baseRoot)) return repoBucket(file, baseRoot, 'base');
  if (inside(file, profile)) return 'trustedProfile';
  if (inside(file, coordinator)) return 'coordinator';
  if ([
    'packages/cupel/src/engine', 'packages/cupel/src/analysis',
    'spec/schemas', 'plans/spikes/s12b',
  ].some(part => inside(file, path.join(project, part)))) return 'transitiveProducer';
  return 'other';
};
const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const call = (method, value) => count(counts.calls, `${bucket(value)}:${method}`);
const guard = value => {
  if (opaque(value)) { counts.opaqueReadDenied++; throw new Error('opaque file read denied'); }
};
const readBytes = (value, data) => {
  const key = bucket(value);
  counts.readBytes[key] = (counts.readBytes[key] ?? 0) + Buffer.byteLength(data);
  if (key === 'unattributed') counts.unattributedFdReads++;
};

fs.readFileSync = function(value, ...args) {
  guard(value); call('readFileSync', value);
  const data = original.readFileSync.call(this, value, ...args);
  readBytes(value, data);
  return data;
};
fs.readFile = function(value, ...args) {
  guard(value); call('readFile', value);
  const callback = args.at(-1);
  if (typeof callback !== 'function') throw new Error('diagnostic readFile callback missing');
  args[args.length - 1] = (error, data) => {
    if (!error) readBytes(value, data);
    callback(error, data);
  };
  return original.readFile.call(this, value, ...args);
};
fs.openSync = function(value, ...args) {
  guard(value); call('openSync', value);
  return original.openSync.call(this, value, ...args);
};
fs.open = function(value, ...args) {
  guard(value); call('open', value);
  return original.open.call(this, value, ...args);
};
fs.createReadStream = function(value, ...args) {
  guard(value); call('createReadStream', value);
  return original.createReadStream.call(this, value, ...args);
};
for (const method of ['readdirSync', 'lstatSync', 'statSync', 'realpathSync']) {
  const bare = original[method];
  fs[method] = function(value, ...args) {
    call(method, value);
    return bare.call(this, value, ...args);
  };
}
fs.promises.readFile = async function(value, ...args) {
  guard(value); call('promiseReadFile', value);
  const data = await original.promiseReadFile(value, ...args);
  readBytes(value, data);
  return data;
};
fs.promises.open = async function(value, ...args) {
  guard(value); call('promiseOpen', value);
  return original.promiseOpen(value, ...args);
};
for (const method of ['readdir', 'lstat', 'stat', 'realpath']) {
  const bare = original[`promise${method[0].toUpperCase()}${method.slice(1)}`];
  fs.promises[method] = async function(value, ...args) {
    call(`promise${method[0].toUpperCase()}${method.slice(1)}`, value);
    return bare(value, ...args);
  };
}
syncBuiltinESMExports();

const snapshot = () => {
  const cpu = process.cpuUsage(cpuStarted);
  const usage = process.resourceUsage();
  return { ...counts,
    wallMs: Number(process.hrtime.bigint() - started) / 1e6,
    parentCpuUserMs: cpu.user / 1000,
    parentCpuSystemMs: cpu.system / 1000,
    parentMaxRssReported: usage.maxRSS,
    rssObserver: 'Node process.resourceUsage().maxRSS; process-local reported units',
  };
};
globalThis.__s16Diagnostic = {
  reset() { counts = blank(); started = process.hrtime.bigint();
    cpuStarted = process.cpuUsage(); frozen = null; },
  freeze() { frozen = snapshot(); return frozen; },
};
process.once('exit', () => {
  original.writeFileSync(report, `${JSON.stringify(frozen ?? snapshot())}\n`);
});
