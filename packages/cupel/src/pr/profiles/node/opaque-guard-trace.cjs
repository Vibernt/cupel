const fs=require('node:fs');
const path=require('node:path');
const {normalizeInputPolicy,EXPRESS}=require('./input-policy.cjs');

if (normalizeInputPolicy(process.env.CUPEL_INPUT_POLICY)!==EXPRESS)
  throw new Error('opaque guard requires express-root-npmrc-opaque-v1');
const root=path.resolve(process.env.CUPEL_ROOT);
const trace=path.resolve(process.env.CUPEL_OPAQUE_TRACE);
if (trace===root || trace.startsWith(root+path.sep))
  throw new Error('opaque trace must be outside repository root');
const fd=fs.openSync(trace,'a');
const write=fs.writeSync.bind(fs);
const child=process.env.NODE_TEST_CONTEXT==='child-v8';
const argument=process.argv[1] ? path.resolve(process.argv[1]) : null;
const owner=child && argument && argument.startsWith(root+path.sep) ?
  path.relative(root,argument).split(path.sep).join('/') : null;
const emit=row=>write(fd,JSON.stringify({pid:process.pid,role:child?'test-child':'parent',owner,...row})+'\n');
const deny=(reason,detail)=>{
  emit({kind:'opaque-denial',reason,detail});
  throw new Error(`Cupel opaque input denied: ${reason}: ${detail}`);
};
const profileRoot=__dirname;
const subject=()=>{
  const stack=new Error().stack;
  if (typeof stack!=='string') return child;
  const frames=stack.split('\n').slice(1);
  if (frames.some(line=>line.includes(root+path.sep) && !line.includes(profileRoot+path.sep)))
    return true;
  if (child && (!frames.length || frames.some(line=>!/^\s*at /.test(line)))) return true;
  return false;
};
module.exports={root,trace,emit,deny,subject};
