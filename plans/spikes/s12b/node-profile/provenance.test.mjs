import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureNodeProfile} from './launch.mjs';
import {testRuntimes as versions} from './test-runtimes.mjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-origin-tests');
mkdirSync(scratch,{recursive:true});
const put=(root,file,source)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,source);};
const events=(result,file,path)=>result.sidecar.files[file].filesystemEvents.filter(event=>event.path===path);
const origins=(result,file,path)=>new Set(events(result,file,path).map(event=>event.origin));

for (const [version,nodePath] of versions) test(`filesystem invocation origin ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'fixture-'));
  const out=mkdtempSync(join(scratch,'output-'));
  put(root,'src/plain.cjs','module.exports=7;\n');
  put(root,'src/plain.mjs','export const value=7;\n');
  put(root,'src/only.ts','export const value: number = 7;\n');
  put(root,'src/read.ts',`import {readFileSync} from 'node:fs';
    export const value: number = Number(readFileSync(new URL('../config.txt',import.meta.url),'utf8'));\n`);
  put(root,'src/top.cjs',`const fs=require('node:fs');const path=require('node:path');
    module.exports=Number(fs.readFileSync(path.join(__dirname,'../config.txt'),'utf8'));\n`);
  put(root,'config.txt','7\n');
  put(root,'tests/import.test.cjs',`const {test}=require('node:test');
    const value=require('../src/plain.cjs');test('CJS import only',()=>{if(value!==7)throw Error('value')});\n`);
  put(root,'tests/esm.test.mjs',`import {test} from 'node:test';import {value} from '../src/plain.mjs';
    test('ESM import only',()=>{if(value!==7)throw Error('value')});\n`);
  put(root,'tests/ts-only.test.mjs',`import {test} from 'node:test';import {value} from '../src/only.ts';
    test('TS import only',()=>{if(value!==7)throw Error('value')});\n`);
  put(root,'tests/top.test.cjs',`const {test}=require('node:test');
    const value=require('../src/top.cjs');test('top-level application read',()=>{if(value!==7)throw Error('value')});\n`);
  put(root,'tests/ts-read.test.mjs',`import {test} from 'node:test';import {value} from '../src/read.ts';
    test('TS top-level application read',()=>{if(value!==7)throw Error('value')});\n`);
  put(root,'tests/same.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');
    const value=require('../src/plain.cjs');test('import and explicit read of same path',()=>{
      if(value!==7||!fs.readFileSync(require.resolve('../src/plain.cjs'),'utf8').includes('module.exports'))throw Error('source pin');
    });\n`);
  put(root,'tests/async.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    const fsp=require('node:fs/promises');test('callback promise and stream',async()=>{
      const p=path.join(__dirname,'../config.txt');
      const callback=await new Promise((ok,bad)=>fs.readFile(p,'utf8',(e,v)=>e?bad(e):ok(v)));
      const promise=await fsp.readFile(p,'utf8');let stream='';
      for await(const chunk of fs.createReadStream(p))stream+=chunk;
      if(callback.trim()!=='7'||promise.trim()!=='7'||stream.trim()!=='7')throw Error('fs');
    });\n`);
  put(root,'tests/unknown.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    test('unparseable stack stays conservative',()=>{const before=Error.prepareStackTrace;
      try{Error.prepareStackTrace=()=>({opaque:true});fs.statSync(path.join(__dirname,'../config.txt'))}
      finally{Error.prepareStackTrace=before}
    });\n`);
  const files=['tests/import.test.cjs','tests/esm.test.mjs','tests/ts-only.test.mjs',
    'tests/top.test.cjs','tests/ts-read.test.mjs','tests/same.test.cjs',
    'tests/async.test.cjs','tests/unknown.test.cjs'];
  const result=captureNodeProfile({root,files,out,nodePath});
  assert.equal(result.constrainedFull.parity,true);
  assert.deepEqual(result.sidecar.completion.errors,[]);
  assert.deepEqual(result.sidecar.denials,[]);
  for (const file of files) assert.ok(result.sidecar.files[file].capabilities.includes('fs-invocation-origin'));
  for (const [file,path] of [
    ['tests/import.test.cjs','src/plain.cjs'],
    ['tests/esm.test.mjs','src/plain.mjs'],
    ['tests/ts-only.test.mjs','src/only.ts'],
  ]) {
    assert.ok(events(result,file,path).length,`${file} has loader evidence`);
    assert.deepEqual([...origins(result,file,path)],['loader'],`${file} has only loader events`);
    assert.ok(!result.sidecar.files[file].filesystemEvents.some(event=>event.origin!=='loader'),
      `${file} has no application FS observer`);
  }
  for (const [file,path] of [
    ['tests/top.test.cjs','config.txt'],
    ['tests/ts-read.test.mjs','config.txt'],
    ['tests/async.test.cjs','config.txt'],
  ]) assert.ok(origins(result,file,path).has('application'),`${file} retains application read`);
  for (const operation of ['readFile','promise.readFile','createReadStream'])
    assert.ok(events(result,'tests/async.test.cjs','config.txt').some(event=>
      event.operation===operation&&event.origin==='application'),`${operation} invocation origin`);
  assert.deepEqual([...origins(result,'tests/same.test.cjs','src/plain.cjs')].sort(),
    ['application','loader']);
  assert.ok(origins(result,'tests/unknown.test.cjs','config.txt').has('unknown'));
  assert.deepEqual(result.sidecar.global.filesystemEvents,[]);
});
