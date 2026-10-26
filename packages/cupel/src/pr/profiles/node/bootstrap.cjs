const {root,deny,emit} = require('./policy.cjs');
require('./coverage.cjs');
require('./inspector-guard.cjs');
require('./modules.cjs');
require('./filesystem.cjs');
require('./nondeterminism.cjs');

const subject = () => {const stack=new Error().stack;
  return typeof stack!=='string' || stack.split('\n').length<2 || stack.includes(root + '/');};
const safeBuiltins=new Set(['assert','assert/strict','buffer','events','fs','fs/promises','module',
  'path','path/posix','path/win32','stream','stream/promises','string_decoder','test',
  'timers','timers/promises','url','util','util/types']);
const builtin = process.getBuiltinModule?.bind(process);
if (builtin) process.getBuiltinModule = name => {
  if (['inspector','inspector/promises'].includes(String(name).replace(/^node:/,'')))
    deny('forbidden-inspector',`process.getBuiltinModule:${name}`);
  if (subject() && !safeBuiltins.has(String(name).replace(/^node:/,'')))
    deny('forbidden-builtin',name);
  return builtin(name);
};
for (const name of ['binding','_linkedBinding']) {
  if (typeof process[name] !== 'function') continue;
  const original = process[name].bind(process);
  process[name] = (...args) => { if (subject()) deny('internal-binding',String(args[0])); return original(...args); };
}
for (const name of ['eval','Function','fetch','WebSocket']) {
  if (typeof globalThis[name] !== 'function') continue;
  const original = globalThis[name];
  globalThis[name] = function (...args) { if (subject()) deny(`forbidden-${name}`,String(args[0]).slice(0,80));
    return original.apply(this,args); };
}
for (const value of [()=>{},async()=>{},function*(){},async function*(){}]) {
  const prototype=Object.getPrototypeOf(value);
  const original=prototype.constructor;
  Object.defineProperty(prototype,'constructor',{configurable:false,writable:false,
    value:function (...args) { if (subject()) deny('forbidden-Function',String(args[0]).slice(0,80));
      return Reflect.construct(original,args,new.target||original); }});
}
emit({kind:'bootstrap-ready',channel:'control',file:process.env.CUPEL_OWNER});
process.on('exit',()=>emit({kind:'bootstrap-exit',channel:'control',file:process.env.CUPEL_OWNER}));
