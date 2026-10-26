import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureNodeProfile} from './launch.mjs';
import {inspectOpaqueFullTrace} from './opaque-full.mjs';
import {testRuntimes} from './test-runtimes.mjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-opaque-runtime-tests');mkdirSync(scratch,{recursive:true});
const policy='express-root-npmrc-opaque-v1';
const put=(root,file,source)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,source);};
const fixture=()=>{const root=mkdtempSync(join(scratch,'fixture-'));
  put(root,'.npmrc','DUMMY_TEST_VALUE_ONLY\n');return root;};

for (const [version,nodePath] of testRuntimes) test(`opaque guarded full and selected head ${version}`,()=>{
  const root=fixture();const out=mkdtempSync(join(scratch,'baseline-'));
  put(root,'package.json',JSON.stringify({name:'fixture',version:'1.0.0'}));
  put(root,'package-lock.json',JSON.stringify({name:'fixture',lockfileVersion:3,packages:{
    '':{name:'fixture',version:'1.0.0'},'node_modules/foo':{version:'1.0.0'}}}));
  put(root,'node_modules/foo/package.json',JSON.stringify({name:'foo',version:'1.0.0',main:'index.cjs'}));
  put(root,'node_modules/foo/index.cjs','module.exports=7;\n');
  put(root,'tests/a.test.cjs',"const {test}=require('node:test');const value=require('foo');test('a',()=>{if(value!==7)throw Error('foo')});\n");
  put(root,'tests/b.test.mjs',"import {test} from 'node:test';import value from 'foo';test('b',()=>{if(value!==7)throw Error('foo')});\n");
  const files=['tests/a.test.cjs','tests/b.test.mjs'];
  const baseline=captureNodeProfile({root,files,out,nodePath,inputPolicy:policy});
  assert.equal(baseline.constrainedFull.parity,true);
  assert.equal(baseline.ordinaryFull.privacyGuarded,true);
  assert.deepEqual(baseline.sidecar.fullReferenceGuard,{
    mode:'privacy-guarded',policy,expectedFiles:files,finishedFiles:files,errors:[],denials:[]});
  assert.deepEqual(baseline.sidecar.global.unsupported,[]);
  assert.deepEqual(baseline.sidecar.denials,[]);
  assert.equal(baseline.sidecar.execution.inputPolicy,policy);
  assert.equal(baseline.sidecar.execution.opaqueRootNpmrc,'regular');
  assert.ok(baseline.sidecar.files[files[0]].capabilities.includes('privacy-guarded-full'));
  assert.ok(!Object.values(baseline.sidecar.files).some(row=>
    [...row.imports,...row.reads,...row.probes].includes('.npmrc')));
  assert.ok(baseline.sidecar.dependencies.files['node_modules/foo/index.cjs']?.startsWith('sha256:'));
  assert.throws(()=>captureNodeProfile({root,files,out:mkdtempSync(join(scratch,'default-')),nodePath}),
    /private input path/);
  const binding={baselineConfigHash:baseline.sidecar.execution.configHash,baselineParity:true,
    environmentPolicyHash:baseline.sidecar.execution.environmentPolicyHash,
    dependencyLockHash:baseline.sidecar.execution.dependencyLockHash,
    profileRuntimeHash:baseline.sidecar.execution.profileRuntimeHash,
    dependencyEvidence:baseline.sidecar.dependencies.files};
  assert.throws(()=>captureNodeProfile({mode:'selected-head',root,files:[files[0]],fullFiles:files,
    out:mkdtempSync(join(scratch,'missing-proof-')),nodePath,inputPolicy:policy,binding}),
    /privacy-guarded full baseline/);
  const selected=captureNodeProfile({mode:'selected-head',root,files:[files[0]],fullFiles:files,
    out:mkdtempSync(join(scratch,'selected-')),nodePath,inputPolicy:policy,
    binding:{...binding,baselinePrivacyGuardedFull:true}});
  assert.equal(selected.ordinaryFull,null);
  assert.deepEqual(selected.sidecar.global.unsupported,[]);
  assert.ok(selected.sidecar.files[files[0]].capabilities.includes('baseline-privacy-bound'));
  unlinkSync(join(root,'.npmrc'));
  assert.throws(()=>captureNodeProfile({mode:'selected-head',root,files:[files[0]],fullFiles:files,
    out:mkdtempSync(join(scratch,'drift-')),nodePath,inputPolicy:policy,
    binding:{...binding,baselinePrivacyGuardedFull:true}}),/environment policy hash/);
});

for (const [version,nodePath] of testRuntimes) test(`absent opaque path still denies negative probes ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'absent-'));const out=mkdtempSync(join(scratch,'absent-out-'));
  put(root,'tests/missing.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');
    const path=require('node:path');test('missing private probes',()=>{
      const p=path.join(__dirname,'../.npmrc');for(const fn of [()=>fs.existsSync(p),
        ()=>fs.statSync(p),()=>fs.accessSync(p)]){let denied=false;
        try{fn()}catch{denied=true}if(!denied)throw Error('unguarded missing probe')}});\n`);
  const result=captureNodeProfile({root,files:['tests/missing.test.cjs'],out,nodePath,inputPolicy:policy});
  assert.equal(result.sidecar.execution.opaqueRootNpmrc,'absent');
  assert.ok(result.sidecar.fullReferenceGuard.denials.length>=3);
  assert.ok(result.sidecar.denials.length>=3);
  assert.ok(result.sidecar.global.unsupported.includes('privacy-guarded-full-denial'));
});

for (const [version,nodePath] of testRuntimes) test(`caught opaque access poisons full reference ${version}`,()=>{
  const root=fixture();const out=mkdtempSync(join(scratch,'negative-'));
  const external=mkdtempSync(join(scratch,'external-private-'));
  put(external,'.env','DUMMY_TEST_VALUE_ONLY\n');
  const externalPrivate=join(external,'.env');
  const file='tests/negative.test.cjs';
  put(root,file,`const {test}=require('node:test');const fs=require('node:fs');
    const fsp=require('node:fs/promises');const path=require('node:path');
    const root=path.resolve(__dirname,'..'),p=path.join(root,'.npmrc');
    const denied=fn=>{let failed=false;try{fn()}catch{failed=true}if(!failed)throw Error('unguarded')};
    const deniedAsync=async fn=>{let failed=false;try{await fn()}catch{failed=true}if(!failed)throw Error('unguarded')};
    test('caught denials',async()=>{
      for(const fn of [()=>fs.readFileSync(p),()=>fs.readFileSync(Buffer.from(p)),
        ()=>fs.readFileSync(new URL('file://'+p)),()=>fs.statSync(p),()=>fs.lstatSync(p),
        ()=>fs.accessSync(p),()=>fs.realpathSync.native(p),()=>fs.existsSync(p),
        ()=>fs.openSync(p,'r'),()=>fs.createReadStream(p),()=>fs.readdirSync(root),
        ()=>fs.readdirSync(root,{recursive:true,withFileTypes:true}),
        ()=>fs.opendirSync(root),()=>fs.existsSync(path.join(root,'.env')),
        ()=>fs.readFileSync(${JSON.stringify(externalPrivate)}),
        ()=>require.resolve('../.npmrc'),()=>require('../.npmrc'),
        ()=>fs.readSync(98765,Buffer.alloc(1),0,1,0),
        ()=>require('node:child_process').execFileSync('cat',[p]),
        ()=>require('node:worker_threads'),()=>require('node:vm'),
        ()=>process.getBuiltinModule('child_process'),()=>process.binding('fs'),
        ()=>process._linkedBinding('fs'),()=>process.dlopen({},p),
        ()=>require('node:module').registerHooks({}),
        ()=>fs.writeFileSync(p,'DUMMY_CHANGED_VALUE_ONLY'),
        ()=>fs.createWriteStream(p)]) denied(fn);
      await deniedAsync(()=>fsp.readFile(p));await deniedAsync(()=>fsp.stat(p));
      await deniedAsync(()=>fsp.open(p,'r'));await deniedAsync(()=>fsp.readdir(root));
      await deniedAsync(()=>new Promise((ok,bad)=>fs.readFile(p,(e,v)=>e?bad(e):ok(v))));
      const previous=Error.prepareStackTrace;
      try{Error.prepareStackTrace=()=>({opaque:true});denied(()=>require('node:child_process'))}
      finally{Error.prepareStackTrace=previous}
    });\n`);
  put(root,'tests/esm-negative.test.mjs',`import {test} from 'node:test';
    test('ESM opaque resolve',async()=>{let caught=false;
      try{import.meta.resolve('../.npmrc')}catch{caught=true}if(!caught)throw Error('unguarded resolve');
      caught=false;try{await import('../.npmrc')}catch{caught=true}if(!caught)throw Error('unguarded import')});\n`);
  const files=[file,'tests/esm-negative.test.mjs'];
  const result=captureNodeProfile({root,files,out,nodePath,inputPolicy:policy});
  assert.equal(result.ordinaryFull.privacyGuarded,true);
  assert.ok(result.ordinaryFull.rows.every(row=>row.status==='passed'),
    'each attempted API must deny before the caught-denial test can pass');
  assert.ok(result.constrainedFull.rows.every(row=>row.status==='passed'),
    'each constrained attempted API must deny before its test can pass');
  assert.ok(result.sidecar.fullReferenceGuard.denials.length>=10);
  assert.ok(result.sidecar.fullReferenceGuard.denials.some(marker=>marker.includes('opaque-escape-module')));
  assert.ok(result.sidecar.fullReferenceGuard.denials.filter(marker=>
    marker.includes('opaque-escape-module:node:child_process')).length>=2);
  assert.ok(result.sidecar.global.unsupported.includes('privacy-guarded-full-denial'));
  assert.ok(result.sidecar.denials.length>=10);
  assert.ok(!result.sidecar.files[file].capabilities.includes('privacy-guarded-full'));
  assert.ok(!result.sidecar.fullReferenceGuard.denials.some(marker=>marker.includes('DUMMY_TEST_VALUE_ONLY')));
});

test('missing, truncated and malformed full guard traces refuse',()=>{
  const out=mkdtempSync(join(scratch,'trace-'));const path=join(out,'trace.jsonl');
  writeFileSync(path,'');
  assert.ok(inspectOpaqueFullTrace(path,['tests/a.test.cjs']).errors.length);
  writeFileSync(path,'{"pid":1,"role":"parent","owner":null,"kind":"opaque-ready"}\n');
  assert.ok(inspectOpaqueFullTrace(path,['tests/a.test.cjs']).errors.length);
  writeFileSync(path,'not json\n');
  assert.ok(inspectOpaqueFullTrace(path,['tests/a.test.cjs']).errors.length);
});
