const fs=require('node:fs');
const path=require('node:path');
const {fileURLToPath}=require('node:url');

// Capture trusted metadata calls before public FS observers are installed.
const stat=fs.statSync.bind(fs);
if (typeof fs.realpathSync.native!=='function')
  throw new Error('opaque input policy requires native realpathSync');
const realpath=fs.realpathSync.native.bind(fs.realpathSync);
const within=(base,p)=>p===base||p.startsWith(base+path.sep);
const pathOf=value=>{
  if (value instanceof URL) return fileURLToPath(value);
  if (typeof value==='string'||Buffer.isBuffer(value)) return path.resolve(String(value));
  return null;
};
const metadata=p=>{
  try {return stat(p);} catch(error) {
    if (error.code==='ENOENT'||error.code==='ENOTDIR') return null;
    throw error;
  }
};
const resolved=p=>{
  try {return realpath(p);} catch(error) {
    if (error.code==='ENOENT'||error.code==='ENOTDIR') return null;
    throw error;
  }
};
const directoryOperation=operation=>/^(?:promise\.)?(?:readdir|opendir|watch)(?:Sync)?$/.test(operation);

/** Return a refusal reason without opening or hashing the opaque file. */
function opaqueAccess(root,value,operation) {
  const p=pathOf(value);
  if (!p) return null;
  const opaque=path.join(root,'.npmrc');
  if (within(opaque,p)) return 'opaque-path';
  if (directoryOperation(operation) && within(p,root)) return 'opaque-parent-enumeration';
  const secret=metadata(opaque);
  if (!secret) return null;
  const candidate=metadata(p);
  if (candidate && candidate.dev===secret.dev && candidate.ino===secret.ino)
    return 'opaque-inode-alias';
  const target=resolved(p);
  if (target && within(opaque,target)) return 'opaque-symlink-alias';
  if (target && directoryOperation(operation) && within(target,root))
    return 'opaque-parent-alias-enumeration';
  return null;
}

module.exports={pathOf,opaqueAccess,directoryOperation};
