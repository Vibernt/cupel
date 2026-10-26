import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNodeProfile, nodeProfileIdentity } from './launch.mjs';
import { testRuntimes as versions } from './test-runtimes.mjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-profile-tests');
mkdirSync(scratch,{recursive:true});
const put=(root,file,text)=>{ const path=join(root,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text); };

for (const [version,nodePath] of versions) test(`node-readonly profile actual runtime ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'fixture-'));
  const out=mkdtempSync(join(scratch,'output-'));
  put(root,'src/value.cjs',"module.exports = { value: 'green' };\n");
  put(root,'src/cached.cjs',"const { readFileSync } = require('node:fs'); module.exports = JSON.parse(readFileSync(require.resolve('../config.json'),'utf8'));\n");
  put(root,'config.json','{"enabled":true}\n');
  put(root,'src/esm.mjs',"import {readFileSync} from 'node:fs'; export const enabled=JSON.parse(readFileSync(new URL('../config.json',import.meta.url),'utf8')).enabled;\n");
  put(root,'tests/pin.test.cjs',`const {test}=require('node:test');const {readFileSync}=require('node:fs');
    test('source pin',()=>{if(!readFileSync(require.resolve('../src/value.cjs'),'utf8').includes('green'))throw Error('pin')});\n`);
  for (const name of ['a','b']) put(root,`tests/cache-${name}.test.cjs`,
    `const {test}=require('node:test');const a=require('../src/cached.cjs');const b=require('../src/cached.cjs');test('cache ${name}',()=>{if(!a.enabled||!b.enabled)throw Error('cache')});\n`);
  put(root,'tests/io.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');const fsp=require('node:fs/promises');
    const {readFileSync: captured,createReadStream}=fs;
    test('all file channels',async()=>{
      if(!require('node:module')._resolveFilename('../src/value.cjs',module).endsWith('value.cjs'))throw Error('resolve');
      if(!captured(require.resolve('../src/value.cjs'),'utf8').includes('green'))throw Error('alias');
      const promise=await fsp.readFile(require.resolve('../config.json'),'utf8');if(!promise.includes('true'))throw Error('promise');
      const callback=await new Promise((resolve,reject)=>fs.readFile(require.resolve('../config.json'),'utf8',(e,v)=>e?reject(e):resolve(v)));
      if(!callback.includes('true'))throw Error('callback');
      let stream='';for await(const part of createReadStream(require.resolve('../src/value.cjs')))stream+=part;
      if(!stream.includes('green'))throw Error('stream');
      const fd=fs.openSync(require.resolve('../src/value.cjs'),'r');const buffer=Buffer.alloc(6);fs.readSync(fd,buffer,0,6,0);fs.closeSync(fd);
      const callbackFd=await new Promise((resolve,reject)=>fs.open(require.resolve('../src/value.cjs'),'r',(e,v)=>e?reject(e):resolve(v)));
      await new Promise((resolve,reject)=>fs.read(callbackFd,Buffer.alloc(1),0,1,0,(e)=>e?reject(e):resolve()));
      await new Promise((resolve,reject)=>fs.close(callbackFd,e=>e?reject(e):resolve()));
      const handle=await fsp.open(require.resolve('../config.json'),'r');if(!(await handle.readFile('utf8')).includes('true'))throw Error('handle');await handle.close();
      if(!fs.realpathSync.native(require.resolve('../src/value.cjs')).endsWith('value.cjs'))throw Error('native path');
      if(fs.existsSync(__dirname+'/../src/missing.cjs'))throw Error('exists');
      try{fs.statSync(__dirname+'/../src/missing.cjs');throw Error('stat')}catch(e){if(e.code!=='ENOENT')throw e}
      if(!fs.readdirSync(__dirname+'/../src').includes('value.cjs'))throw Error('dir');
    });\n`);
  put(root,'tests/esm.test.mjs',`import {test} from 'node:test';import {enabled} from '../src/esm.mjs';
    test('esm cached A',{concurrency:true},async()=>{const again=await import('../src/esm.mjs');if(!enabled||!again.enabled)throw Error('esm')});
    test('esm cached B',{concurrency:true},async()=>{const again=await import('../src/esm.mjs');if(!enabled||!again.enabled)throw Error('esm')});\n`);
  const files=['tests/pin.test.cjs','tests/cache-a.test.cjs','tests/cache-b.test.cjs','tests/io.test.cjs','tests/esm.test.mjs'];
  const result=captureNodeProfile({root,files,out,nodePath});
  const identity=nodeProfileIdentity({root,files,version});
  assert.equal(result.sidecar.execution.configHash,identity.configHash);
  assert.equal(result.sidecar.execution.environmentPolicyHash,identity.environmentPolicyHash);
  assert.throws(()=>captureNodeProfile({root,files,out,nodePath,binding:{configHash:'sha256:wrong'}}),/caller config hash/);
  assert.deepEqual(result.sidecar.completion.errors,[]);
  assert.deepEqual(result.sidecar.denials,[]);
  assert.equal(result.constrainedFull.parity,true);
  for (const file of files) {
    assert.deepEqual(result.sidecar.files[file].unsupported,[]);
    for (const capability of ['module-linkage','fs-sync','fs-async','fs-stream','fs-descriptor',
      'metadata','directory','readonly-boundary','unsupported-controls','fs-invocation-origin','results-parity'])
      assert.ok(result.sidecar.files[file].capabilities.includes(capability),`${version} ${file} ${capability}`);
  }
  assert.equal(result.constrainedFull.rows.length,6);
  assert.ok(result.sidecar.files['tests/pin.test.cjs'].reads.includes('src/value.cjs'));
  assert.ok(result.sidecar.files['tests/pin.test.cjs'].filesystemEvents.some(event=>
    event.path==='src/value.cjs'&&event.origin==='application'));
  for (const name of ['a','b']) assert.ok(result.sidecar.files[`tests/cache-${name}.test.cjs`].reads.includes('config.json'));
  const io=result.sidecar.files['tests/io.test.cjs'];
  assert.ok(io.reads.includes('src/value.cjs'));
  assert.ok(io.probes.includes('src/missing.cjs'));
  assert.ok(io.directories.includes('src'));
  assert.ok(result.sidecar.files['tests/esm.test.mjs'].imports.includes('src/esm.mjs'));
  assert.ok(result.sidecar.files['tests/esm.test.mjs'].reads.includes('config.json'));
  put(root,'tests/new.test.cjs',"const {test}=require('node:test');test('new head test',()=>{});\n");
  const headFiles=[...files,'tests/new.test.cjs'];
  const headConfigHash=nodeProfileIdentity({root,files:headFiles,version}).configHash;
  const selected=captureNodeProfile({mode:'selected-head',root,files:['tests/new.test.cjs'],
    fullFiles:headFiles,out:mkdtempSync(join(scratch,'selected-')),nodePath,binding:{
      baselineConfigHash:result.sidecar.execution.configHash,baselineParity:true,
      headConfigHash,environmentPolicyHash:result.sidecar.execution.environmentPolicyHash,
      dependencyLockHash:result.sidecar.execution.dependencyLockHash,
      profileRuntimeHash:result.sidecar.execution.profileRuntimeHash,
      dependencyEvidence:result.sidecar.dependencies.files}});
  assert.equal(selected.ordinaryFull,null);
  assert.equal(selected.constrainedFull.parity,null);
  assert.deepEqual(selected.sidecar.global.unsupported,[]);
  assert.deepEqual(selected.sidecar.completion.finishedFiles,['tests/new.test.cjs']);
  assert.equal(selected.selectedHead.rows.length,1);
  assert.equal(selected.sidecar.execution.configHash,headConfigHash);
  assert.notEqual(headConfigHash,result.sidecar.execution.configHash);
  assert.ok(selected.sidecar.files['tests/new.test.cjs'].capabilities.includes('baseline-parity-bound'));
});

for (const [version,nodePath] of versions) test(`private output and refusal controls ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'private-'));const out=mkdtempSync(join(scratch,'private-out-'));
  put(root,'tests/private.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    test('private writes',()=>{const p=path.join(process.env.TMPDIR,'result.txt');fs.writeFileSync(p,'ok');if(fs.readFileSync(p,'utf8')!=='ok')throw Error('private')});\n`);
  const privateRun=captureNodeProfile({root,files:['tests/private.test.cjs'],out,nodePath,compareFull:false});
  assert.deepEqual(privateRun.sidecar.denials,[]);
  assert.deepEqual(privateRun.sidecar.completion.errors,[]);
  const crossRoot=mkdtempSync(join(scratch,'cross-'));const crossOut=mkdtempSync(join(scratch,'cross-out-'));
  put(crossRoot,'tests/cross.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    test('caught cross-file TMP read',()=>{let caught=false;try{fs.readFileSync(path.join(process.env.TMPDIR,'../other/token'))}catch(e){caught=true}if(!caught)throw Error('cross')});\n`);
  put(crossOut,'other/token','secret-free test token');
  const cross=captureNodeProfile({root:crossRoot,files:['tests/cross.test.cjs'],out:crossOut,nodePath,compareFull:false});
  assert.ok(cross.sidecar.denials.some(row=>row.marker.startsWith('external-path:')));
  const symlinkRoot=mkdtempSync(join(scratch,'symlink-'));const symlinkOut=mkdtempSync(join(scratch,'symlink-out-'));
  put(symlinkRoot,'tests/symlink.test.cjs',"const {test}=require('node:test');test('still',()=>{});\n");
  symlinkSync(join(symlinkRoot,'tests/symlink.test.cjs'),join(symlinkRoot,'tests/alias.test.cjs'));
  assert.throws(()=>captureNodeProfile({root:symlinkRoot,files:['tests/symlink.test.cjs'],out:symlinkOut,nodePath}),/refuses symlink/);
  const emptyRoot=mkdtempSync(join(scratch,'empty-'));const emptyOut=mkdtempSync(join(scratch,'empty-out-'));
  put(emptyRoot,'tests/empty.test.cjs','process.exit(0);\n');
  const empty=captureNodeProfile({root:emptyRoot,files:['tests/empty.test.cjs'],out:emptyOut,nodePath,compareFull:false});
  assert.ok(empty.sidecar.completion.errors.length>0);
  const truncRoot=mkdtempSync(join(scratch,'trunc-'));const truncOut=mkdtempSync(join(scratch,'trunc-out-'));
  put(truncRoot,'tests/trunc.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');const path=require('node:path');
    test('truncated trace',()=>fs.writeFileSync(path.join(process.env.TMPDIR,'events.jsonl'),''));\n`);
  const trunc=captureNodeProfile({root:truncRoot,files:['tests/trunc.test.cjs'],out:truncOut,nodePath,compareFull:false});
  assert.ok(trunc.sidecar.completion.errors.some(value=>value.includes('hook trace')));
});

for (const [version,nodePath] of versions) test(`caught nondeterminism controls ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'clock-'));const out=mkdtempSync(join(scratch,'clock-out-'));
  put(root,'tests/clock.test.cjs',`const {test}=require('node:test');
    const attempts=[['Date()',()=>Date('2000')],['new Date()',()=>new Date()],['Date.now',()=>Date.now()],
      ['Math.random',()=>Math.random()],['performance.now',()=>performance.now()],
      ['performance.timeOrigin',()=>performance.timeOrigin],['process.hrtime',()=>process.hrtime()],
      ['process.hrtime.bigint',()=>process.hrtime.bigint()],['process.uptime',()=>process.uptime()],
      ['process.cpuUsage',()=>process.cpuUsage()],['process.resourceUsage',()=>process.resourceUsage()],
      ['process.memoryUsage',()=>process.memoryUsage()],['process.memoryUsage.rss',()=>process.memoryUsage.rss()],
      ['process.pid',()=>process.pid],['process.ppid',()=>process.ppid],
      ['global.navigator',()=>navigator.userAgent],
      ['global.crypto',()=>crypto.getRandomValues(new Uint8Array(1))],
      ['module.crypto',()=>require('node:crypto').randomBytes(1)]];
    test('caught changing inputs',()=>{for(const [name,call] of attempts){let caught=false;
      try{call()}catch(e){caught=true}if(!caught)throw Error('not denied: '+name)}});
    test('deterministic date and math',()=>{if(new Date(0).getTime()!==0)throw Error('date');
      if(Date.parse('2000-01-01')!==946684800000)throw Error('parse');
      if(Date.UTC(2000,0,1)!==946684800000)throw Error('UTC');
      if(Math.sqrt(9)!==3)throw Error('math')});\n`);
  const result=captureNodeProfile({root,files:['tests/clock.test.cjs'],out,nodePath,compareFull:false});
  assert.deepEqual(result.sidecar.completion.errors,[]);
  for (const name of ['Date()','new Date()','Date.now','Math.random','performance.now',
    'performance.timeOrigin','process.hrtime','process.hrtime.bigint','process.uptime',
    'process.cpuUsage','process.resourceUsage','process.memoryUsage','process.memoryUsage.rss',
    'process.pid','process.ppid','global.navigator','global.crypto'])
    assert.ok(result.sidecar.denials.some(row=>row.marker===`nondeterministic-input:${name}`),`${version} ${name}`);
  assert.ok(result.sidecar.denials.some(row=>row.marker.startsWith('forbidden-module:node:crypto')));
});

const blocked = [
  ['repo-write',"require('node:fs').writeFileSync(__dirname+'/../src/value.cjs','red')",'repository-write'],
  ['external-read',"require('node:fs').readFileSync('/etc/hosts')",'external-path'],
  ['unknown-fd',"require('node:fs').readSync(999,Buffer.alloc(1),0,1,0)",'unknown-descriptor'],
  ['fd-reuse',"{const fs=require('node:fs');const fd=fs.openSync(__dirname+'/../src/value.cjs','r');fs.closeSync(fd);fs.readSync(fd,Buffer.alloc(1),0,1,0)}",'unknown-descriptor'],
  ['fd-write',"require('node:fs').openSync(__dirname+'/../src/value.cjs','w')",'repository-write'],
  ['promise-write',"await require('node:fs/promises').writeFile(__dirname+'/../src/value.cjs','red')",'repository-write'],
  ['watch',"require('node:fs').watch(__dirname+'/../src')",'unsupported-fs-api'],
  ['promise-chmod',"await require('node:fs/promises').chmod(__dirname+'/../src/value.cjs',511)",'repository-write'],
  ['handle-chmod',"{const h=await require('node:fs/promises').open(__dirname+'/../src/value.cjs','r');try{await h.chmod(511)}finally{await h.close()}}",'unsupported-filehandle-api'],
  ['child',"require('node:child_process').spawnSync('true')",'forbidden-module'],
  ['builtin-child',"process.getBuiltinModule('node:child_process').spawnSync('true')",'forbidden-builtin'],
  ['os',"require('node:os').hostname()",'forbidden-module'],
  ['builtin-os',"process.getBuiltinModule('node:os').hostname()",'forbidden-builtin'],
  ['module-load',"require('node:module')._load('node:child_process',module).spawnSync('true')",'forbidden-module'],
  ['worker',"require('node:worker_threads').Worker",'forbidden-module'],
  ['vm',"require('node:vm').runInNewContext('1')",'forbidden-module'],
  ['wasi',"require('node:wasi').WASI",'forbidden-module'],
  ['addon',"process.dlopen({},'/tmp/unknown.node')",'native-addon'],
  ['network',"fetch('http://127.0.0.1:1')",'forbidden-fetch'],
  ['loader',"require('node:module').registerHooks({resolve(){}})",'custom-loader'],
  ['eval',"eval('1+1')",'forbidden-eval'],
  ['function',"Function('return 1')()",'forbidden-Function'],
  ['indirect-function',"(()=>{}).constructor('return 1')()",'forbidden-Function'],
  ['async-function',"Object.getPrototypeOf(async()=>{}).constructor('return 1')()",'forbidden-Function'],
];
for (const [version,nodePath] of versions) test(`caught denials remain visible ${version}`,()=>{
  for (const [name,expression,reason] of blocked) {
    const root=mkdtempSync(join(scratch,`${name}-`));const out=mkdtempSync(join(scratch,`${name}-out-`));
    put(root,'src/value.cjs',"module.exports='green';\n");
    put(root,'tests/denial.test.cjs',`const {test}=require('node:test');
      test('caught ${name}',async()=>{let caught=false;try{${expression}}catch(error){caught=true}if(!caught)throw Error('denial was not enforced')});\n`);
    const result=captureNodeProfile({root,files:['tests/denial.test.cjs'],out,nodePath,compareFull:false});
    assert.ok(result.sidecar.denials.some(row=>row.marker.startsWith(reason+':')),
      `${version} ${name}: ${JSON.stringify(result.sidecar)}`);
  }
});
