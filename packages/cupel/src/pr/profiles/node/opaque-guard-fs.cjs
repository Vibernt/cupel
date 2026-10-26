const fs=require('node:fs');
const fsp=require('node:fs/promises');
const Module=require('node:module');
const {root,trace,deny,subject}=require('./opaque-guard-trace.cjs');
const {opaqueAccess}=require('./opaque-target.cjs');
const {pathOf}=require('./opaque-target.cjs');
const {privatePath}=require('./privacy.cjs');
const path=require('node:path');
const paths=new Set(['readFile','writeFile','appendFile','stat','lstat','access','realpath','readlink',
  'readdir','opendir','exists','open','truncate','chmod','chown','utimes','lutimes',
  'rm','rmdir','mkdir','mkdtemp','unlink','watch','watchFile','unwatchFile',
  'copyFile','cp','rename','link','symlink']);
const dual=new Set(['copyFile','cp','rename','link','symlink']);
const descriptors=new Map();
const originals=new Map(Object.entries(fs).filter(([,value])=>typeof value==='function'));
const promiseOriginals=new Map(Object.entries(fsp).filter(([,value])=>typeof value==='function'));
const handled=new Set(),handledPromises=new Set();
const check=(value,operation)=>{
  const p=pathOf(value);
  if (p===trace && subject()) deny('opaque-guard-trace-access',operation);
  if (p && privatePath(p)) deny('private-input-access',`${operation}:${p}`);
  const reason=opaqueAccess(root,value,operation);
  if (reason) deny('opaque-input-access',`${operation}:${reason}`);
};
const checkFd=(fd,operation)=>{
  if (fd===0||fd===1||fd===2) return;
  if (!descriptors.has(fd) && subject()) deny('unknown-descriptor',`${operation}:${fd}`);
};
const track=(fd,path)=>{if(Number.isInteger(fd)) descriptors.set(fd,path);};
const base=name=>name.endsWith('Sync')?name.slice(0,-4):name;

for (const name of [...paths].flatMap(name=>[name,name+'Sync'])) {
  if (typeof fs[name]!=='function') continue;
  const original=fs[name];handled.add(name);
  fs[name]=function (...args) {
    const operation=base(name);
    if (typeof args[0]==='number') checkFd(args[0],name);
    else check(args[0],name);
    if (dual.has(operation)) check(args[1],`${name}.target`);
    if (operation==='open' && name==='openSync') {
      const fd=original.apply(this,args);track(fd,args[0]);return fd;
    }
    if (operation==='open' && name==='open' && typeof args.at(-1)==='function') {
      const callback=args.at(-1);
      args[args.length-1]=function(error,fd,...rest){if(!error)track(fd,args[0]);
        return callback.call(this,error,fd,...rest);};
    }
    return original.apply(this,args);
  };
  if (typeof original.native==='function') fs[name].native=function (...args){
    check(args[0],`${name}.native`);return original.native.apply(original,args);};
}
for (const name of ['readSync','readvSync','writeSync','writevSync','fstatSync','fsyncSync',
  'ftruncateSync','read','readv','write','writev','fstat','fsync','ftruncate','closeSync','close']) {
  if (typeof fs[name]!=='function') continue;
  const original=fs[name];handled.add(name);
  fs[name]=function (fd,...args) {
    checkFd(fd,name);
    if (name==='closeSync') {const value=original.call(this,fd,...args);descriptors.delete(fd);return value;}
    if (name==='close' && typeof args.at(-1)==='function') {
      const callback=args.at(-1);
      args[args.length-1]=function (...result){if(!result[0])descriptors.delete(fd);
        return callback.apply(this,result);};
    }
    return original.call(this,fd,...args);
  };
}
for (const name of ['createReadStream','createWriteStream','ReadStream','WriteStream']) {
  if (typeof fs[name]!=='function') continue;
  const original=fs[name];handled.add(name);
  fs[name]=function (p,...args) {
    check(p,name);if (args[0]?.fd!==undefined) checkFd(args[0].fd,`${name}.fd`);
    return name.endsWith('Stream')&&name.startsWith('create') ? original.call(this,p,...args) :
      Reflect.construct(original,[p,...args],new.target||original);
  };
}
for (const name of paths) {
  if (typeof fsp[name]!=='function') continue;
  const original=fsp[name];handledPromises.add(name);
  fsp[name]=async function (...args) {
    if (typeof args[0]?.fd==='number') checkFd(args[0].fd,`promise.${name}`);
    else check(args[0],`promise.${name}`);
    if (dual.has(name)) check(args[1],`promise.${name}.target`);
    const value=await original.apply(this,args);
    if (name==='open') {track(value.fd,args[0]);const close=value.close.bind(value);
      value.close=async(...params)=>{const result=await close(...params);descriptors.delete(value.fd);return result;};}
    return value;
  };
}
for (const name of ['Stats','Dirent','StatWatcher']) handled.add(name);
for (const [name,original] of originals) if (!handled.has(name)) fs[name]=function(...args){
  if (subject()) deny('unsupported-opaque-fs-api',name);return original.apply(this,args);};
for (const [name,original] of promiseOriginals) if (!handledPromises.has(name)) fsp[name]=function(...args){
  if (subject()) deny('unsupported-opaque-fs-promise-api',name);return original.apply(this,args);};
Module.syncBuiltinESMExports();
