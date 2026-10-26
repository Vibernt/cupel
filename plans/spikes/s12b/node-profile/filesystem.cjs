const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const {inspect,emit,deny,pathOf,relative,root,within} = require('./policy.cjs');
const {opened,use,closed,writeFlags} = require('./descriptors.cjs');
const {invocationOrigin} = require('./provenance.cjs');
const originalFs=new Map(Object.entries(fs).filter(([,value])=>typeof value==='function'));
const originalPromises=new Map(Object.entries(fsp).filter(([,value])=>typeof value==='function'));
const handled=new Set();
const handledPromises=new Set();

const readOps = new Set(['readFile','stat','lstat','access','realpath','readlink','readdir','opendir','exists']);
const metadata = new Set(['stat','lstat','access','realpath','readlink','exists']);
const dirs = new Set(['readdir','opendir']);
const writes = new Set(['writeFile','appendFile','copyFile','cp','rename','rm','rmdir','mkdir','mkdtemp',
  'unlink','link','symlink','truncate','chmod','chown','lchmod','lchown','lutimes','utimes']);
const baseName = name => name.endsWith('Sync') ? name.slice(0,-4) : name;
const channel = name => dirs.has(name) ? 'directories' : metadata.has(name) ? 'probes' : 'reads';
const observe = (name,arg,{write = false} = {}) => {
  const origin=invocationOrigin();
  const base = baseName(name);
  const path = inspect(arg,name,{missing:metadata.has(base)||dirs.has(base),write});
  if (within(__dirname,path)) return;
  emit({kind:name,channel:write?'writes':channel(base),file:within(root,path)?relative(path):path,origin});
};
const secondPath = new Set(['copyFile','cp','rename','link','symlink']);
const checkSecond = (base,args) => {
  if (base==='link' || base==='symlink') deny('link-operation',base);
  if (secondPath.has(base)) inspect(args[1],`${base}.target`,{write:true});
};
const patchSync = name => {
  const original = fs[name];
  handled.add(name);
  fs[name] = function (...args) {
    const base = baseName(name);
    if (name === 'readFileSync' && typeof args[0] === 'number') use(args[0],name);
    else observe(name,args[0],{write:writes.has(base)});
    checkSecond(base,args);
    if (name === 'openSync') {
      const p = inspect(args[0],name,{write:writeFlags(args[1])});
      const fd = original.apply(this,args); opened(fd,p); return fd;
    }
    return original.apply(this,args);
  };
  if (typeof original.native === 'function') fs[name].native = function (...args) {
    observe(`${name}.native`,args[0]); return original.native.apply(original,args);
  };
};
for (const name of [...readOps].flatMap(base => [base+'Sync']).filter(name=>typeof fs[name]==='function')) patchSync(name);
for (const name of [...writes].flatMap(base => [base+'Sync']).filter(name=>typeof fs[name]==='function')) patchSync(name);
patchSync('openSync');
for (const name of ['readSync','readvSync','writeSync','writevSync','fstatSync','fsyncSync','ftruncateSync']) {
  if (typeof fs[name] !== 'function') continue;
  handled.add(name);
  const original = fs[name];
  fs[name] = function (fd,...args) {
    use(fd,name);
    if (/^write|truncate/.test(name)) deny('descriptor-write',`${name}:${fd}`);
    return original.call(this,fd,...args);
  };
}
const closeSync = fs.closeSync;
handled.add('closeSync');
fs.closeSync = function (fd,...args) { use(fd,'closeSync'); const value=closeSync.call(this,fd,...args); closed(fd); return value; };
for (const name of ['read','readv','write','writev','fstat','fsync','ftruncate','close']) {
  if (typeof fs[name] !== 'function') continue;
  handled.add(name); const original=fs[name];
  fs[name]=function (fd,...args) {
    use(fd,name);
    if (/^(?:write|ftruncate)/.test(name)) deny('descriptor-write',`${name}:${fd}`);
    if (name==='close' && typeof args.at(-1)==='function') {
      const callback=args.at(-1);
      args[args.length-1]=function (...result) { if (!result[0]) closed(fd); return callback.apply(this,result); };
    }
    return original.call(this,fd,...args);
  };
}
for (const name of [...readOps,...writes,'open']) {
  if (typeof fs[name] !== 'function') continue;
  handled.add(name);
  const original = fs[name];
  fs[name] = function (...args) {
    const base = baseName(name);
    if (name === 'readFile' && typeof args[0] === 'number') use(args[0],name);
    else observe(name,args[0],{write:writes.has(base)});
    checkSecond(base,args);
    if (name === 'open') inspect(args[0],name,{write:writeFlags(args[1])});
    const cb = args.at(-1);
    if (name === 'open' && typeof cb === 'function') args[args.length-1] = function (error,fd,...rest) {
      if (!error) opened(fd,pathOf(args[0])); return cb.call(this,error,fd,...rest);
    };
    return original.apply(this,args);
  };
}
for (const name of [...readOps,...writes,'open']) {
  if (typeof fsp[name] !== 'function') continue;
  handledPromises.add(name);
  const original = fsp[name];
  fsp[name] = async function (...args) {
    observe(`promise.${name}`,args[0],{write:writes.has(name)});
    checkSecond(name,args);
    if (name === 'open') inspect(args[0],name,{write:writeFlags(args[1])});
    const value = await original.apply(this,args);
    if (name === 'open') {
      opened(value.fd,pathOf(args[0]));
      for (const method of ['read','readv','readFile','stat','write','writev','writeFile','appendFile','truncate']) {
        if (typeof value[method] !== 'function') continue;
        const call = value[method].bind(value);
        value[method] = (...params) => { use(value.fd,`handle.${method}`);
          if (/^(?:write|append|truncate)/.test(method)) deny('descriptor-write',`handle.${method}`);
          return call(...params); };
      }
      const close = value.close.bind(value);
      value.close = async (...params) => { use(value.fd,'handle.close'); const result=await close(...params); closed(value.fd); return result; };
      for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(value))) {
        if (method==='constructor' || Object.hasOwn(value,method) || typeof value[method]!=='function') continue;
        value[method]=()=>deny('unsupported-filehandle-api',method);
      }
    }
    return value;
  };
}
for (const name of ['createReadStream','createWriteStream']) {
  const original = fs[name];
  handled.add(name);
  fs[name] = function (p,...args) { observe(name,p,{write:name==='createWriteStream'}); return original.call(this,p,...args); };
}
for (const name of ['ReadStream','WriteStream']) {
  if (typeof fs[name] !== 'function') continue;
  const original=fs[name]; handled.add(name);
  fs[name]=function (p,...args) { observe(name,p,{write:name==='WriteStream'});
    return Reflect.construct(original,[p,...args],new.target||original); };
}
for (const name of ['Stats','Dirent','StatWatcher']) handled.add(name);
const fromSubject=()=>{const stack=new Error().stack;
  return typeof stack!=='string'||stack.split('\n').length<2||stack.includes(root+'/');};
for (const [name,original] of originalFs) if (!handled.has(name)) fs[name]=function (...args) {
  if (fromSubject()) deny('unsupported-fs-api',name);
  return original.apply(this,args);
};
for (const [name,original] of originalPromises) if (!handledPromises.has(name)) fsp[name]=function (...args) {
  if (fromSubject()) deny('unsupported-fs-promise-api',name);
  return original.apply(this,args);
};
Module.syncBuiltinESMExports();
