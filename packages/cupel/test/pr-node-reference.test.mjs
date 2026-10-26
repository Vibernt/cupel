import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditNodeReference, verifyReferenceProcessProof} from '../src/pr/profiles/node/reference.mjs';
import {referenceRows} from '../src/pr/profiles/node/reference-results.mjs';
import {profileRequestSnapshot} from '../src/pr/profiles/node/snapshot.mjs';
import {nodeProfileProducerProof} from '../src/pr/producer.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/', import.meta.url));
const nodePath = '/opt/homebrew/Cellar/node/26.7.0/bin/node';
function fixture(sources) {
  mkdirSync(scratch,{recursive:true});
  const parent = mkdtempSync(join(scratch,'pr-reference-'));
  const root = join(parent,'project'); mkdirSync(root); mkdirSync(join(root,'tests'));
  const files = Object.keys(sources).sort();
  for (const [file,source] of Object.entries(sources)) writeFileSync(join(root,file),source);
  const extension = files.every(file => file.endsWith('.test.cjs')) ? 'cjs' : 'mjs';
  const config = {runners:{node:{tests:`tests/**/*.test.${extension}`}}};
  const args = () => ({root,files,out:join(parent,`out-${Date.now()}-${Math.random()}`),
    config,nodePath,expectedProducerHash:nodeProfileProducerProof().producerHash,
    expectedIdentity:profileRequestSnapshot({root,files,version:'26.7.0'}).identity});
  return {parent,root,files,args,close:()=>rmSync(parent,{recursive:true,force:true})};
}
const normal = "import {test} from 'node:test'; test('works [critical]',()=>{});\n";

test('reference uses two complete Node 26 default-isolation runs and canonical rows', () => {
  const f=fixture({'tests/a.test.mjs':normal,
    'tests/b.test.mjs':"import {test} from 'node:test'; test('works [minor]',()=>{});\n"});
  try {
    const result=auditNodeReference(f.args());
    assert.equal(result.kind,'complete');
    assert.equal(result.mode,'readonly-normal-runner-reference-v1');
    assert.equal(result.runRows.length,2);
    assert.deepEqual(result.runRows[0],result.runRows[1]);
    assert.deepEqual(result.runRows[0].map(row=>row.id),[
      'tests/a.test.mjs::works [critical]','tests/b.test.mjs::works [minor]']);
    assert.equal(result.processProofs.length,2);
    for (const proof of result.processProofs) {
      assert.equal(proof.complete,true);
      assert.deepEqual(proof.expectedFiles,proof.seenFiles);
      assert.equal(proof.childPids.length,2);
      assert.notEqual(proof.childPids[0],proof.childPids[1]);
      assert.deepEqual(proof.denials,[]);
    }
    assert.equal(result.identity.runtimeVersion,'26.7.0');
    assert.equal(result.costs.executionMs.length,2);
  } finally {f.close();}
});

test('reference keeps nested duplicate, skipped and genuine failed rows distinct', () => {
  const f=fixture({'tests/a.test.mjs':"import {test,describe} from 'node:test';\ndescribe('group',()=>{test('duplicate [critical]',()=>{});test('duplicate [critical]',()=>{});test.skip('later',()=>{});test('bad',()=>{throw Error('expected')});});\n"});
  try {
    const result=auditNodeReference(f.args());
    assert.deepEqual(result.runRows[0].map(row=>[row.id,row.status]),[
      ['tests/a.test.mjs::group > bad','failed'],
      ['tests/a.test.mjs::group > duplicate [critical]','failed'],
      ['tests/a.test.mjs::group > duplicate [critical] #2','failed'],
      ['tests/a.test.mjs::group > later','skipped']]);
  } finally {f.close();}
});

test('subject temporary writes stay inside its own subtree', () => {
  const f=fixture({'tests/a.test.mjs':"import {test} from 'node:test';import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';test('temp',()=>{const p=join(process.env.TMPDIR,'data');writeFileSync(p,'ok');if(readFileSync(p,'utf8')!=='ok')throw Error('temp');});\n"});
  try {assert.equal(auditNodeReference(f.args()).kind,'complete');}
  finally {f.close();}
});

test('CommonJS test files use the same complete isolation and row contract', () => {
  const f=fixture({'tests/a.test.cjs':"const {test}=require('node:test');test('cjs [standard]',()=>{});\n"});
  try {
    const result=auditNodeReference(f.args());
    assert.deepEqual(result.runRows[0],[{id:'tests/a.test.cjs::cjs [standard]',
      file:'tests/a.test.cjs',name:'cjs [standard]',status:'passed',tags:['standard']}]);
  } finally {f.close();}
});

test('caught resource and private control denials persist and refuse reference', () => {
  const cases = [
    "import{writeFileSync}from'node:fs';try{writeFileSync('tests/a.test.mjs','x')}catch{}",
    "import{writeFileSync}from'node:fs';try{writeFileSync(process.env.CUPEL_PRIVATE_TMP+'/events.jsonl','x')}catch{}",
    "import{readFileSync}from'node:fs';try{readFileSync(process.env.CUPEL_PRIVATE_TMP+'/events.jsonl')}catch{}",
    "try{await import('node:child_process')}catch{}",
    "try{await import('node:worker_threads')}catch{}",
    "try{await import('node:net')}catch{}",
    "try{await import('node:inspector')}catch{}",
    "import{registerHooks}from'node:module';try{registerHooks({})}catch{}",
    "try{process.dlopen({},'x.node')}catch{}",
    "try{process._debugProcess(process.pid)}catch{}",
    "try{await fetch('https://example.invalid')}catch{}",
  ];
  for (const source of cases) {
    const f=fixture({'tests/a.test.mjs':`${source}\nimport {test} from 'node:test';test('caught',()=>{});\n`});
    try {assert.throws(()=>auditNodeReference(f.args()),/reference resource denial/);}
    finally {f.close();}
  }
});

test('reference rejects missing trusted pins, source edits and symlink output before subject', () => {
  const f=fixture({'tests/a.test.mjs':normal});
  try {
    const args=f.args();
    assert.throws(()=>auditNodeReference({...args,expectedIdentity:null}),/expected fresh profile identity/);
    assert.throws(()=>auditNodeReference({...args,expectedProducerHash:'sha256:'+'0'.repeat(64)}),/producer differs/);
    const testFile=join(f.root,f.files[0]); const stat=lstatSync(testFile);
    writeFileSync(testFile,normal.replace('works','other'));
    utimesSync(testFile,stat.atime,stat.mtime);
    assert.equal(lstatSync(testFile).size,stat.size);
    assert.throws(()=>auditNodeReference(args),/expected fresh profile identity/);
    const symlink=join(f.parent,'linked'); symlinkSync(join(f.parent,'actual'),symlink);
    assert.throws(()=>auditNodeReference({...f.args(),out:join(symlink,'out')}),/reference output|ENOENT/);
  } finally {f.close();}
});

test('Node 22 refuses before subject and parser rejects duplicate, missing and foreign proof', () => {
  const f=fixture({'tests/a.test.mjs':normal});
  try {
    const args=f.args();
    assert.throws(()=>auditNodeReference({...args,nodePath:'/opt/homebrew/opt/node@22/bin/node'}),
      /requires verified Node 26\.7\.0/);
    assert.equal(lstatSync(f.parent).isDirectory(),true);
    const base={type:'test:start',data:{testId:1,parentId:0,name:'x',
      file:join(f.root,f.files[0]),entryFile:join(f.root,f.files[0]),line:1,column:1}};
    const pass={type:'test:pass',data:{...base.data,details:{duration_ms:1}}};
    const plan={type:'test:plan',data:{count:1,nesting:0}};
    const encode=events=>events.map(event=>JSON.stringify(event)).join('\n')+'\n';
    assert.throws(()=>referenceRows(encode([base,base,pass,plan]),f.root,new Set(f.files)),/duplicate/);
    assert.throws(()=>referenceRows(encode([base,plan]),f.root,new Set(f.files)),/missing/);
    assert.throws(()=>referenceRows(encode([{...base,data:{...base.data,
      entryFile:join(f.parent,'foreign.test.mjs')}},pass,plan]),f.root,new Set(f.files)),/foreign|escapes/);
  } finally {f.close();}
});

test('process proof rejects truncated, duplicate, foreign and mismatched child records', () => {
  const parent={owner:'reference-run-0',kind:'reference-ready',role:'parent',pid:100,ppid:99,file:null,context:null};
  const child={owner:'reference-run-0',kind:'reference-ready',role:'child',pid:101,ppid:100,
    file:'tests/a.test.mjs',context:'child-v8'};
  const encode=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  const rows=[parent,child,{...child,kind:'reference-exit'},
    {...parent,kind:'reference-exit'}];
  assert.equal(verifyReferenceProcessProof(encode(rows),new Set(['tests/a.test.mjs']),100,0).complete,true);
  assert.throws(()=>verifyReferenceProcessProof(encode(rows.slice(0,-1)),new Set(['tests/a.test.mjs']),100,0),/missing or truncated/);
  assert.throws(()=>verifyReferenceProcessProof(encode([...rows,child]),new Set(['tests/a.test.mjs']),100,0),/missing or truncated/);
  assert.throws(()=>verifyReferenceProcessProof(encode(rows),new Set(['tests/b.test.mjs']),100,0),/foreign|missing/);
  assert.throws(()=>verifyReferenceProcessProof(encode(rows),new Set(['tests/a.test.mjs']),102,0),/invalid reference parent/);
  assert.throws(()=>verifyReferenceProcessProof('{',new Set(['tests/a.test.mjs']),100,0),/malformed or truncated/);
});
