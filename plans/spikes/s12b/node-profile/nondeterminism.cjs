const {root,deny} = require('./policy.cjs');
const fromSubject=()=>{const stack=new Error().stack;
  return typeof stack!=='string'||stack.split('\n').length<2||stack.includes(root+'/');};
const refuse=name=>{ if (fromSubject()) deny('nondeterministic-input',name); };

const DateOriginal=globalThis.Date;
const DateGuard=new Proxy(DateOriginal,{
  apply(target,thisArg,args) { refuse('Date()'); return Reflect.apply(target,thisArg,args); },
  construct(target,args,newTarget) { if (!args.length) refuse('new Date()');
    return Reflect.construct(target,args,newTarget); },
  get(target,key,receiver) { if (key==='now') return function () { refuse('Date.now'); return DateOriginal.now(); };
    return Reflect.get(target,key,receiver); },
});
globalThis.Date=DateGuard;

const random=Math.random;
Math.random=function () { refuse('Math.random'); return random(); };

const performanceOriginal=globalThis.performance;
if (performanceOriginal) {
  const performanceGuard=new Proxy(performanceOriginal,{
    get(target,key) { refuse(`performance.${String(key)}`);
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value; },
  });
  Object.defineProperty(globalThis,'performance',{configurable:false,get() {
    return fromSubject()?performanceGuard:performanceOriginal;
  }});
}

for (const name of ['hrtime','uptime','cpuUsage','resourceUsage','memoryUsage']) {
  const original=process[name];
  if (typeof original!=='function') continue;
  const wrapped=function (...args) { refuse(`process.${name}`); return original.apply(process,args); };
  for (const key of Object.keys(original)) if (typeof original[key]==='function')
    wrapped[key]=function (...args) { refuse(`process.${name}.${key}`); return original[key](...args); };
  process[name]=wrapped;
}
for (const name of ['pid','ppid']) {
  const original=process[name];
  Object.defineProperty(process,name,{configurable:false,enumerable:true,get() {
    refuse(`process.${name}`); return original;
  }});
}
for (const name of ['crypto','navigator']) {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
  if (!descriptor?.configurable) continue;
  Object.defineProperty(globalThis,name,{configurable:false,get() {
    refuse(`global.${name}`);
    return descriptor.get?descriptor.get.call(globalThis):descriptor.value;
  }});
}
