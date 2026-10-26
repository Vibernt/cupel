// Experimental preload only. One runner process is assigned one test file.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');
const { resolve, relative, sep } = require('node:path');

const root = resolve(process.env.CUPEL_TRACE_ROOT || '.');
const owner = resolve(root, process.env.CUPEL_TRACE_OWNER || '');
const out = process.env.CUPEL_TRACE_OUT;
if (!out || owner === root) throw new Error('trace requires CUPEL_TRACE_OUT and CUPEL_TRACE_OWNER');
const append = fs.appendFileSync.bind(fs);
const inside = p => {
  try {
    if (p instanceof URL) p = fileURLToPath(p);
    if (typeof p !== 'string' && !Buffer.isBuffer(p)) return null;
    const abs = resolve(String(p));
    if (abs === resolve(out)) return null;
    const rel = relative(root, abs).split(sep).join('/');
    return rel && rel !== '..' && !rel.startsWith('../') &&
      !rel.split('/').some(part => part.startsWith('.') || part === 'node_modules') ? rel : null;
  } catch { return null; }
};
const record = (kind, path, result, extra = {}) => {
  const file = inside(path);
  if (!file) return;
  const stack = new Error().stack || '';
  append(out, JSON.stringify({ owner:relative(root, owner).split(sep).join('/'), file, kind, result,
    direct:stack.includes(owner), ...extra }) + '\n');
};
const outcome = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : error ? 'error' : 'present';

function sync(name, kind = name, pathAt = 0) {
  const original = fs[name];
  const wrapped = function (...args) {
    try {
      const value = original.apply(this, args);
      record(kind, args[pathAt], name === 'existsSync' ? value ? 'present' : 'absent' : 'present');
      return value;
    } catch (error) { record(kind, args[pathAt], outcome(error), { code:error.code }); throw error; }
  };
  if (typeof original.native === 'function') wrapped.native = function (...args) {
    try { const value = original.native.apply(original, args); record(`${kind}.native`, args[pathAt], 'present'); return value; }
    catch (error) { record(`${kind}.native`, args[pathAt], outcome(error), { code:error.code }); throw error; }
  };
  fs[name] = wrapped;
}
function callback(name, kind = name, pathAt = 0) {
  const original = fs[name];
  fs[name] = function (...args) {
    const index = args.findLastIndex(arg => typeof arg === 'function');
    if (index < 0) return original.apply(this, args);
    const done = args[index];
    args[index] = function (...result) {
      record(`callback.${kind}`, args[pathAt], name === 'exists' ? result[0] ? 'present' : 'absent' : outcome(result[0]));
      return done.apply(this, result);
    };
    return original.apply(this, args);
  };
}
function promise(name, kind = name, pathAt = 0) {
  const original = fsp[name];
  if (typeof original !== 'function') return;
  fsp[name] = async function (...args) {
    try { const value = await original.apply(this, args); record(`promise.${kind}`, args[pathAt], 'present'); return value; }
    catch (error) { record(`promise.${kind}`, args[pathAt], outcome(error), { code:error.code }); throw error; }
  };
}

for (const name of ['readFileSync','statSync','lstatSync','accessSync','realpathSync','readlinkSync',
  'readdirSync','opendirSync','openSync','existsSync']) sync(name);
for (const name of ['readFile','stat','lstat','access','realpath','readlink','readdir','opendir','open','exists']) callback(name);
for (const name of ['readFile','stat','lstat','access','realpath','readlink','readdir','opendir','open']) promise(name);
const stream = fs.createReadStream;
fs.createReadStream = function (path, ...args) {
  const value = stream.call(this, path, ...args);
  record('createReadStream', path, 'present');
  value.on('error', error => record('createReadStream', path, outcome(error), { code:error.code }));
  return value;
};
for (const name of ['writeFileSync','appendFileSync','createWriteStream','renameSync','unlinkSync','mkdirSync']) {
  const original = fs[name];
  fs[name] = function (...args) { record(name, args[0], 'write'); return original.apply(this, args); };
}
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try { const path = resolveFilename.call(this, request, parent, ...rest); if (!Module.isBuiltin(path)) record('cjs-resolve', path, 'present', { parent:inside(parent?.filename) }); return path; }
  catch (error) { record('cjs-resolve', resolve(parent?.filename ? require('node:path').dirname(parent.filename) : root, request), outcome(error), { code:error.code }); throw error; }
};
Module.syncBuiltinESMExports();
