const Module = require('node:module');
const { fileURLToPath } = require('node:url');
const path = require('node:path');
const {root,within,relative,lockedPath,emit,deny} = require('./policy.cjs');
const {EXPRESS,normalizeInputPolicy}=require('./input-policy.cjs');
const {opaqueModuleRequest}=require('./opaque-module.cjs');
const {opaqueAccess}=require('./opaque-target.cjs');
const opaque=normalizeInputPolicy(process.env.CUPEL_INPUT_POLICY)===EXPRESS;
const trusted = __dirname;

const originalRegisterHooks = Module.registerHooks;
const originalResolveFilename=Module._resolveFilename;
const blocked = new Set(['node:child_process','child_process','node:worker_threads','worker_threads',
  'node:cluster','cluster','node:vm','vm','node:net','net','node:http','http',
  'node:https','https','node:dgram','dgram','node:tls','tls','node:wasi','wasi']);
const safeBuiltins=new Set(['assert','assert/strict','buffer','events','fs','fs/promises','module',
  'path','path/posix','path/win32','stream','stream/promises','string_decoder','test',
  'timers','timers/promises','url','util','util/types']);
originalRegisterHooks({
  resolve(specifier, context, nextResolve) {
    if (opaque) {const reason=opaqueModuleRequest(root,specifier,context.parentURL);
      if (reason) deny('opaque-input-access',`resolve:${reason}`);}
    if (blocked.has(specifier)) deny('forbidden-module',speciferLabel(specifier));
    if (context.parentURL?.startsWith(`file://${root}/`) && Module.isBuiltin(specifier) &&
        !safeBuiltins.has(specifier.replace(/^node:/,''))) deny('forbidden-module',specifier);
    const answer = nextResolve(specifier, context);
    if (answer.url.startsWith('node:')) return answer;
    if (!answer.url.startsWith('file:')) deny('non-file-module',answer.url);
    const file = fileURLToPath(answer.url);
    if (opaque) {const reason=opaqueAccess(root,file,'module-resolve');
      if (reason) deny('opaque-input-access',`resolved:${reason}`);}
    if (file === path.join(trusted,'reporter.mjs') ||
      (within(trusted,file) && context.parentURL?.startsWith(`file://${trusted}/`))) return answer;
    if (!within(root,file)) deny('external-module',file);
    if (file.split(path.sep).includes('node_modules') && !lockedPath(relative(file)))
      deny('unlocked-package-module',file);
    const nativeJs=/\.(?:[cm]?js|json)$/.test(file);
    const nativeTs=/\.(?:ts|mts|cts)$/.test(file);
    if (!nativeJs && !nativeTs) deny('non-native-module',file);
    if (file.split(path.sep).includes('node_modules') && nativeTs)
      deny('non-js-package-module',file);
    emit({kind:'module-linkage',channel:'imports',file:relative(file),parent:context.parentURL ?? null});
    return answer;
  },
});
Module._resolveFilename=function (...args) {
  if (opaque) {const reason=opaqueModuleRequest(root,args[0],args[1]?.filename);
    if (reason) deny('opaque-input-access',`require.resolve:${reason}`);}
  const result=originalResolveFilename.apply(this,args);
  if (opaque && typeof result==='string') {const reason=opaqueAccess(root,result,'module-resolve');
    if (reason) deny('opaque-input-access',`resolved:${reason}`);}
  if (typeof result==='string' && !Module.isBuiltin(result) && within(root,result))
    emit({kind:'module-resolve',channel:'imports',file:relative(result),parent:args[1]?.filename??null});
  return result;
};
const speciferLabel = value => String(value);
for (const name of ['register','registerHooks']) {
  Object.defineProperty(Module,name,{configurable:false,writable:false,value:(...args)=>deny('custom-loader',`${name}:${args[0] ?? ''}`)});
}
const dlopen = process.dlopen;
process.dlopen = function (...args) { deny('native-addon',String(args[1] ?? '')); return dlopen.apply(this,args); };
Module.syncBuiltinESMExports();
