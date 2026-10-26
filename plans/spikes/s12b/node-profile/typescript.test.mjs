import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNodeProfile } from './launch.mjs';
import { testRuntimes as versions } from './test-runtimes.mjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const scratch=join(repo,'.scratch/s12b/node-typescript-tests');mkdirSync(scratch,{recursive:true});
const put=(root,file,text)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,text);};

for (const [version,nodePath] of versions) test(`native erasable TypeScript ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'fixture-'));const out=mkdtempSync(join(scratch,'out-'));
  const source="export const plus = (n: number): number => n + 1;\n";
  put(root,'src/value.ts',source);
  put(root,'tests/value.test.mjs',`import {test} from 'node:test';import {plus} from '../src/value.ts';
    test('native TS import',()=>{if(plus(1)!==2)throw Error('changed TS behavior')});
    test('cached native TS import',async()=>{const again=await import('../src/value.ts');
      if(again.plus(1)!==2)throw Error('changed TS cache')});\n`);
  put(root,'tests/independent.test.mjs',"import {test} from 'node:test';test('independent',()=>{});\n");
  const files=['tests/value.test.mjs','tests/independent.test.mjs'];
  const baseline=captureNodeProfile({root,files,out,nodePath});
  assert.deepEqual(baseline.sidecar.completion.errors,[]);
  assert.deepEqual(baseline.sidecar.denials,[]);
  assert.equal(baseline.constrainedFull.parity,true);
  assert.ok(baseline.sidecar.files[files[0]].imports.includes('src/value.ts'));
  assert.ok(baseline.sidecar.files[files[0]].capabilities.includes('native-typescript'));
  assert.ok(baseline.sidecar.nativeTypeScript.files['src/value.ts']?.startsWith('sha256:'));
  put(root,'src/value.ts',source.replace('n + 1','n + 2'));
  const head=captureNodeProfile({root,files,out:mkdtempSync(join(scratch,'head-')),nodePath});
  const selected=captureNodeProfile({mode:'selected-head',root,files:[files[0]],fullFiles:files,
    out:mkdtempSync(join(scratch,'selected-')),nodePath,binding:{
      baselineConfigHash:baseline.sidecar.execution.configHash,baselineParity:true,
      environmentPolicyHash:baseline.sidecar.execution.environmentPolicyHash,
      dependencyLockHash:baseline.sidecar.execution.dependencyLockHash,
      profileRuntimeHash:baseline.sidecar.execution.profileRuntimeHash,
      dependencyEvidence:baseline.sidecar.dependencies.files}});
  assert.ok(head.ordinaryFull.rows.some(row=>row.status==='failed'));
  assert.ok(selected.constrainedFull.rows.some(row=>row.status==='failed'));
  assert.equal(selected.sidecar.completion.expectedFiles.length,1);
  assert.equal(selected.ordinaryFull,null);
  assert.deepEqual(selected.sidecar.global.unsupported,[]);

  put(root,'src/value.ts','export enum Unsupported { A }\n');
  const unsupported=captureNodeProfile({root,files:[files[0]],out:mkdtempSync(join(scratch,'unsupported-')),
    nodePath,compareFull:false});
  assert.ok(unsupported.sidecar.files[files[0]].unsupported.includes('unsupported-native-typescript-syntax'));
  put(root,'src/value.tsx','export const JSX = <div />;\n');
  put(root,'tests/tsx.test.mjs',"import {test} from 'node:test';import '../src/value.tsx';test('unsupported TSX',()=>{});\n");
  const tsx=captureNodeProfile({root,files:['tests/tsx.test.mjs'],out:mkdtempSync(join(scratch,'tsx-')),
    nodePath,compareFull:false});
  assert.ok(tsx.sidecar.denials.some(row=>row.marker.startsWith('non-native-module:')));
});
