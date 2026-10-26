const Module=require('node:module');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const {root,deny,subject}=require('./opaque-guard-trace.cjs');
const {opaqueModuleRequest}=require('./opaque-module.cjs');
const {opaqueAccess}=require('./opaque-target.cjs');
const {privatePath}=require('./privacy.cjs');

const blocked=new Set(['child_process','worker_threads','cluster','vm','wasi','module']);
const blockedBuiltin=value=>{
  const name=String(value).replace(/^node:/,'');
  return blocked.has(name) && name!=='module';
};
const parentInRoot=value=>{
  if (typeof value!=='string' || !value.startsWith('file:')) return false;
  let file;
  try {file=fileURLToPath(value);} catch {return true;}
  return file===root || file.startsWith(root+path.sep);
};
const checkRequest=(request,parent,operation)=>{
  const reason=opaqueModuleRequest(root,request,parent);
  if (reason) deny('opaque-input-access',`${operation}:${reason}`);
};
const checkResult=(result,operation)=>{
  if (typeof result!=='string') return;
  if (privatePath(result)) deny('private-input-access',`${operation}:${result}`);
  const reason=opaqueAccess(root,result,'module-resolve');
  if (reason) deny('opaque-input-access',`${operation}:${reason}`);
};
const originalRegisterHooks=Module.registerHooks;
originalRegisterHooks({resolve(specifier,context,nextResolve){
  if (parentInRoot(context.parentURL) && blockedBuiltin(specifier))
    deny('opaque-escape-module',specifier);
  checkRequest(specifier,context.parentURL,'esm-resolve');
  const answer=nextResolve(specifier,context);
  if (answer.url.startsWith('file:')) checkResult(fileURLToPath(answer.url),'esm-resolved');
  return answer;
}});
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...rest){
  checkRequest(request,parent?.filename,'cjs-resolve');
  const result=originalResolve.call(this,request,parent,...rest);
  checkResult(result,'cjs-resolved');
  return result;
};
const originalLoad=Module._load;
Module._load=function(request,parent,...rest){
  if (subject() && blockedBuiltin(request)) deny('opaque-escape-module',request);
  checkRequest(request,parent?.filename,'cjs-load');
  return originalLoad.call(this,request,parent,...rest);
};
for (const name of ['register','registerHooks']) {
  const original=Module[name];
  Module[name]=function(...args){if(subject())deny('opaque-custom-loader',name);
    return original.apply(this,args);};
}
const dlopen=process.dlopen;
process.dlopen=function(...args){if(subject())deny('opaque-native-addon',String(args[1]??''));
  return dlopen.apply(this,args);};
const builtin=process.getBuiltinModule?.bind(process);
if (builtin) process.getBuiltinModule=name=>{
  if (subject() && blockedBuiltin(name))deny('opaque-escape-module',name);
  return builtin(name);
};
for (const name of ['binding','_linkedBinding']) {
  if (typeof process[name]!=='function') continue;
  const original=process[name].bind(process);
  process[name]=(...args)=>{if(subject())deny('opaque-internal-binding',`${name}:${args[0]}`);
    return original(...args);};
}
Module.syncBuiltinESMExports();
