import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNodeProfile, nodeProfileIdentity } from './launch.mjs';
import { observedDependencyEvidence } from './dependencies.mjs';
import { testRuntimes as nodes } from './test-runtimes.mjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-dependency-tests');
mkdirSync(scratch,{recursive:true});
const put=(root,file,text)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);};
const lock=(integrity='sha512-fixture')=>JSON.stringify({name:'profile-fixture',lockfileVersion:3,
  packages:{'':{name:'profile-fixture',version:'1.0.0'},
    'node_modules/foo':{version:'1.0.0',integrity},
    'node_modules/bar':{version:'1.0.0',integrity},
    'node_modules/uninstalled':{version:'9.0.0',integrity}}},null,2)+'\n';

for (const [version,nodePath] of nodes) test(`locked pure JS closure ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'fixture-'));const out=mkdtempSync(join(scratch,'out-'));
  put(root,'package.json',JSON.stringify({name:'profile-fixture',version:'1.0.0',private:true,type:'module'})+'\n');
  put(root,'package-lock.json',lock());
  put(root,'config.json','{"enabled":true}\n');
  put(root,'node_modules/foo/package.json',JSON.stringify({name:'foo',version:'1.0.0',main:'index.cjs'})+'\n');
  put(root,'node_modules/foo/index.cjs',"module.exports=require('bar');\n");
  put(root,'node_modules/bar/package.json',JSON.stringify({name:'bar',version:'1.0.0',main:'index.cjs'})+'\n');
  const bar="const fs=require('node:fs');module.exports=JSON.parse(fs.readFileSync(require.resolve('../../config.json'),'utf8'));\n";
  put(root,'node_modules/bar/index.cjs',bar);
  put(root,'tests/cjs.test.cjs',"const {test}=require('node:test');const a=require('foo');const b=require('foo');test('CJS cache',()=>{if(!a.enabled||!b.enabled)throw Error('cache')});\n");
  put(root,'tests/esm.test.mjs',"import {test} from 'node:test';import foo from 'foo';test('ESM import',()=>{if(!foo.enabled)throw Error('esm')});\n");
  const files=['tests/cjs.test.cjs','tests/esm.test.mjs'];
  const baseline=captureNodeProfile({root,files,out,nodePath});
  assert.deepEqual(baseline.sidecar.completion.errors,[]);
  assert.deepEqual(baseline.sidecar.denials,[]);
  assert.equal(baseline.constrainedFull.parity,true);
  for (const file of files) {
    assert.deepEqual(baseline.sidecar.files[file].unsupported,[]);
    assert.ok(baseline.sidecar.files[file].capabilities.includes('locked-pure-js'));
  }
  assert.deepEqual(baseline.constrainedFull.rows.map(row=>row.status),['passed','passed']);
  for (const file of files) assert.ok(baseline.sidecar.files[file].reads.includes('config.json'),`${version} top-level read ${file}`);
  for (const dependency of ['node_modules/foo/index.cjs','node_modules/bar/index.cjs',
    'node_modules/foo/package.json','node_modules/bar/package.json'])
    assert.ok(baseline.sidecar.dependencies.files[dependency]?.startsWith('sha256:'),`${version} ${dependency}`);
  const identity=nodeProfileIdentity({root,files,version});
  assert.equal(identity.dependencyLockHash,baseline.sidecar.dependencies.lockHash);

  put(root,'node_modules/bar/index.cjs',`// changed installed bytes\n${bar}`);
  const changed=captureNodeProfile({root,files,out:mkdtempSync(join(scratch,'changed-')),nodePath,
    binding:{dependencyEvidence:baseline.sidecar.dependencies.files}});
  assert.ok(changed.sidecar.global.unsupported.includes('changed-dependency-installation'));
  assert.throws(()=>captureNodeProfile({mode:'selected-head',root,files:[files[0]],fullFiles:files,
    out:mkdtempSync(join(scratch,'selected-changed-')),nodePath,binding:{
      baselineConfigHash:baseline.sidecar.execution.configHash,baselineParity:true,
      environmentPolicyHash:baseline.sidecar.execution.environmentPolicyHash,
      dependencyLockHash:baseline.sidecar.execution.dependencyLockHash,
      profileRuntimeHash:baseline.sidecar.execution.profileRuntimeHash,
      dependencyEvidence:baseline.sidecar.dependencies.files}}),/baseline dependency bytes changed/);
  put(root,'node_modules/bar/index.cjs',bar);
  put(root,'package-lock.json',lock('sha512-different'));
  assert.throws(()=>captureNodeProfile({root,files,out:mkdtempSync(join(scratch,'lock-')),nodePath,
    binding:{dependencyLockHash:identity.dependencyLockHash}}),/dependency lock hash/);
  put(root,'package-lock.json',lock());
  put(root,'node_modules/bar/index.cjs',"try{require('node:child_process')}catch{}module.exports={enabled:true};\n");
  const denied=captureNodeProfile({root,files,out:mkdtempSync(join(scratch,'denied-')),nodePath});
  assert.ok(denied.sidecar.denials.some(row=>row.marker.startsWith('forbidden-module:node:child_process')));
});

for (const [version,nodePath] of nodes) test(`locked dependency private paths refuse ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'private-'));
  put(root,'package-lock.json',lock());
  put(root,'node_modules/foo/package.json',JSON.stringify({name:'foo',version:'1.0.0'})+'\n');
  const privateFiles=['application_default_credentials.json','secrets/config.json',
    '.config/gcloud/config.json','.npmrc'];
  for (const file of privateFiles) put(root,`node_modules/foo/${file}`,'DUMMY_TEST_VALUE_ONLY\n');
  put(root,'tests/private.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');
    const path=require('node:path');test('private package input',()=>{
      for(const file of ${JSON.stringify(privateFiles)}){
        try{fs.readFileSync(path.join(__dirname,'../node_modules/foo',file),'utf8')}catch{}
      }
    });\n`);
  const result=captureNodeProfile({root,files:['tests/private.test.cjs'],
    out:mkdtempSync(join(scratch,'private-out-')),nodePath,compareFull:false});
  for (const file of privateFiles) {
    assert.ok(result.sidecar.denials.some(row=>row.marker.includes(`node_modules/foo/${file}`)),file);
    assert.throws(()=>observedDependencyEvidence(root,[`node_modules/foo/${file}`],{
      packages:{'node_modules/foo':{name:'foo',version:'1.0.0'}}}),/unsupported dependency file/,file);
  }
});
