import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-snapshot-tests');mkdirSync(scratch,{recursive:true});
const put=(root,file,source)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,source);};
const lock=name=>JSON.stringify({name,lockfileVersion:3,packages:{'':{name}}});

test('one in-request preflight and lock read; caller snapshot cannot be spoofed',async()=>{
  const root=mkdtempSync(join(scratch,'fixture-'));const out=mkdtempSync(join(scratch,'output-'));
  put(root,'package-lock.json',lock('snapshot'));
  put(root,'tests/value.test.cjs',"const {test}=require('node:test');test('value',()=>{});\n");
  const target=resolve(root,'tests/value.test.cjs'),lockPath=resolve(root,'package-lock.json');
  const fs=require('node:fs'),child=require('node:child_process');
  const originalRead=fs.readFileSync,originalSpawn=child.spawnSync;
  let fixtureReads=0,lockReads=0,versionProbes=0;
  fs.readFileSync=function(path,...args) {
    if (resolve(String(path))===target) fixtureReads++;
    if (resolve(String(path))===lockPath) lockReads++;
    return originalRead.call(this,path,...args);
  };
  child.spawnSync=function(binary,args,...rest) {
    if (args?.includes('--version')) versionProbes++;
    return originalSpawn.call(this,binary,args,...rest);
  };
  syncBuiltinESMExports();
  try {
    const {captureNodeProfile}=await import('./launch.mjs');
    assert.throws(()=>captureNodeProfile({root,files:['tests/value.test.cjs'],out,
      requestSnapshot:{validated:true}}),/caller-provided/);
    const result=captureNodeProfile({root,files:['tests/value.test.cjs'],out});
    assert.equal(result.constrainedFull.parity,true);
    assert.deepEqual(result.sidecar.global.unsupported,[]);
    assert.equal(fixtureReads,2,'one pre-execution and one post-execution input read');
    assert.equal(lockReads,4,'one inventory and one locked metadata read before and after');
    assert.equal(versionProbes,0,'current process version needs no child probe');
  } finally {
    fs.readFileSync=originalRead;child.spawnSync=originalSpawn;syncBuiltinESMExports();
  }
});

test('fresh post-run inventory and lock reject an input changed during execution',async()=>{
  const root=mkdtempSync(join(scratch,'changed-'));const out=mkdtempSync(join(scratch,'changed-output-'));
  put(root,'package-lock.json',lock('before'));
  put(root,'src/value.txt','before\n');
  const file='tests/change.test.cjs';
  put(root,file,`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    test('external change handshake',()=>{const ready=path.join(process.env.TMPDIR,'ready');
      const done=path.join(process.env.TMPDIR,'done');fs.writeFileSync(ready,'ready');
      const slot=new Int32Array(new SharedArrayBuffer(4));for(let i=0;i<1000;i++){
        if(fs.existsSync(done))return;Atomics.wait(slot,0,0,5)
      }throw Error('external fixture writer did not finish')});\n`);
  const privateTmp=join(out,'tests_change.test.cjs');
  const writer=`const fs=require('node:fs');const [ready,done,value,lock]=process.argv.slice(1);
    const slot=new Int32Array(new SharedArrayBuffer(4));for(let i=0;i<1000;i++){
      if(fs.existsSync(ready)){fs.writeFileSync(value,'after\\n');
        fs.writeFileSync(lock,JSON.stringify({name:'after',lockfileVersion:3,packages:{'':{name:'after'}}}));
        fs.writeFileSync(done,'done');process.exit(0)}Atomics.wait(slot,0,0,5)
    }process.exit(3);`;
  const worker=spawn(process.execPath,['-e',writer,join(privateTmp,'ready'),join(privateTmp,'done'),
    join(root,'src/value.txt'),join(root,'package-lock.json')],{stdio:'ignore'});
  try {
    const {captureNodeProfile}=await import('./launch.mjs');
    const result=captureNodeProfile({root,files:[file],out,compareFull:false});
    assert.ok(result.sidecar.global.unsupported.includes('changed-input-inventory'));
    assert.ok(result.sidecar.global.unsupported.includes('changed-dependency-lock'));
  } finally {if (worker.exitCode===null) worker.kill();}
});

test('selected head rechecks observed dependency bytes after execution',async()=>{
  const root=mkdtempSync(join(scratch,'dependency-'));
  const baselineOut=mkdtempSync(join(scratch,'dependency-baseline-'));
  const headOut=mkdtempSync(join(scratch,'dependency-head-'));
  put(root,'package-lock.json',JSON.stringify({name:'dependency',lockfileVersion:3,packages:{
    '':{name:'dependency'},'node_modules/foo':{version:'1.0.0'}}}));
  put(root,'node_modules/foo/package.json',JSON.stringify({name:'foo',version:'1.0.0',main:'index.cjs'}));
  put(root,'node_modules/foo/index.cjs','module.exports=7;\n');
  const file='tests/dependency.test.cjs';
  put(root,file,"const {test}=require('node:test');const value=require('foo');test('dependency',()=>{if(value!==7)throw Error('value')});\n");
  const {captureNodeProfile}=await import('./launch.mjs');
  const baseline=captureNodeProfile({root,files:[file],out:baselineOut});
  assert.equal(baseline.constrainedFull.parity,true);
  assert.deepEqual(baseline.sidecar.global.unsupported,[]);
  put(root,file,`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    const value=require('foo');test('dependency',()=>{const ready=path.join(process.env.TMPDIR,'ready');
      const done=path.join(process.env.TMPDIR,'done');fs.writeFileSync(ready,'ready');
      const slot=new Int32Array(new SharedArrayBuffer(4));for(let i=0;i<1000;i++){
        if(fs.existsSync(done)){if(value!==7)throw Error('value');return}Atomics.wait(slot,0,0,5)
      }throw Error('external dependency writer did not finish')});\n`);
  const privateTmp=join(headOut,'tests_dependency.test.cjs');
  const writer=`const fs=require('node:fs');const [ready,done,value]=process.argv.slice(1);
    const slot=new Int32Array(new SharedArrayBuffer(4));for(let i=0;i<1000;i++){
      if(fs.existsSync(ready)){fs.writeFileSync(value,'module.exports=8;\\n');
        fs.writeFileSync(done,'done');process.exit(0)}Atomics.wait(slot,0,0,5)
    }process.exit(3);`;
  const worker=spawn(process.execPath,['-e',writer,join(privateTmp,'ready'),join(privateTmp,'done'),
    join(root,'node_modules/foo/index.cjs')],{stdio:'ignore'});
  try {
    const selected=captureNodeProfile({mode:'selected-head',root,files:[file],fullFiles:[file],
      out:headOut,binding:{baselineConfigHash:baseline.sidecar.execution.configHash,
        baselineParity:true,environmentPolicyHash:baseline.sidecar.execution.environmentPolicyHash,
        dependencyLockHash:baseline.sidecar.execution.dependencyLockHash,
        profileRuntimeHash:baseline.sidecar.execution.profileRuntimeHash,
        dependencyEvidence:baseline.sidecar.dependencies.files}});
    assert.ok(selected.sidecar.global.unsupported.includes('baseline-dependency-bytes-changed-during-run'));
    assert.deepEqual(selected.sidecar.completion.errors,[]);
  } finally {if (worker.exitCode===null) worker.kill();}
});
