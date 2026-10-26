const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { invocationOrigin } = require('./provenance.cjs');
const { privatePath } = require('./privacy.cjs');
const {normalizeInputPolicy,EXPRESS}=require('./input-policy.cjs');
const {opaqueAccess}=require('./opaque-target.cjs');

const root = path.resolve(process.env.CUPEL_ROOT);
const tmp = path.resolve(process.env.CUPEL_PRIVATE_TMP);
const owner = process.env.CUPEL_OWNER;
const inputPolicy=normalizeInputPolicy(process.env.CUPEL_INPUT_POLICY);
const inputs = new Set(JSON.parse(process.env.CUPEL_INPUTS));
const lockedPackages = JSON.parse(process.env.CUPEL_LOCKED_PACKAGES || '[]');
const lstat = fs.lstatSync.bind(fs);
const trace = path.join(tmp, 'events.jsonl');
const reporter = path.join(__dirname,'reporter.mjs');
const logFd = fs.openSync(trace,'a');
const write = fs.writeSync.bind(fs);
const within = (base, p) => p === base || p.startsWith(base + path.sep);
const pathOf = value => {
  if (value instanceof URL) return fileURLToPath(value);
  if (typeof value === 'string' || Buffer.isBuffer(value)) return path.resolve(String(value));
  return null;
};
const relative = p => path.relative(root, p).split(path.sep).join('/');
const lockedPath = (rel, directory = false) => {
  if (privatePath(rel)) return false;
  if (directory && lockedPackages.some(key=>key===rel||key.startsWith(rel+'/'))) return true;
  return lockedPackages.some(key=>rel.startsWith(key+'/') &&
    (directory || /\.(?:[cm]?js|json)$/.test(rel)));
};
const emit = row => write(logFd, JSON.stringify({owner,...row}) + '\n');
const deny = (reason, detail) => { emit({kind:'unsupported',reason,detail}); throw new Error(`Cupel node profile unsupported: ${reason}: ${detail}`); };
const inspect = (value, operation, {missing = false, write = false} = {}) => {
  const origin = invocationOrigin();
  if (inputPolicy===EXPRESS) {
    const reason=opaqueAccess(root,value,operation);
    if (reason) return deny('opaque-input-access',`${operation}:${reason}`);
  }
  const p = pathOf(value);
  if (!p) return deny('unresolved-path', operation);
  if (p === reporter || p === path.join(__dirname,'nondeterminism.cjs')) return p;
  if (within(tmp,p)) {
    for (let segment=p; within(tmp,segment); segment=path.dirname(segment)) {
      try { if (lstat(segment).isSymbolicLink()) deny('symlink-path',`${operation}:${p}`); }
      catch (error) { if (error.code!=='ENOENT' && error.code!=='ENOTDIR') throw error; }
      if (segment===tmp) break;
    }
    emit({kind:operation,file:p,channel:write?'private-write':'private-read'}); return p;
  }
  if (!within(root,p)) return deny('external-path', `${operation}:${p}`);
  const rel = relative(p);
  if (privatePath(rel)) return deny('private-input-access',`${operation}:${rel}`);
  if (write) return deny('repository-write', `${operation}:${rel}`);
  for (let segment = p; within(root,segment); segment = path.dirname(segment)) {
    try { if (lstat(segment).isSymbolicLink()) deny('symlink-path', `${operation}:${rel}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (segment === root) break;
  }
  if (!inputs.has(rel) && ![...inputs].some(file => file.startsWith(rel + '/')) &&
      !lockedPath(rel,missing)) {
    if (!missing) return deny('undeclared-repository-read', `${operation}:${rel}`);
    try { lstat(p); return deny('undeclared-repository-read', `${operation}:${rel}`); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  emit({kind:operation,file:rel,channel:'repository-read',origin});
  return p;
};
module.exports = {root,tmp,owner,inputs,lockedPath,trace,within,pathOf,relative,emit,deny,inspect};
