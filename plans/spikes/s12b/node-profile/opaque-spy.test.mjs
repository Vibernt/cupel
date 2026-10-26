import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,linkSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testRuntimes} from './test-runtimes.mjs';

const repo=fileURLToPath(new URL('../../../..',import.meta.url));
const profile=join(repo,'plans/spikes/s12b/node-profile');
const scratch=join(repo,'.scratch/s12b/node-opaque-spy-tests');mkdirSync(scratch,{recursive:true});
const put=(root,file,source)=>{const p=join(root,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,source);};

for (const [version,nodePath] of testRuntimes) test(`ordinary guard denies before original content API ${version}`,()=>{
  const root=mkdtempSync(join(scratch,'fixture-'));
  const out=mkdtempSync(join(scratch,'output-'));
  put(root,'.npmrc','DUMMY_TEST_VALUE_ONLY\n');
  linkSync(join(root,'.npmrc'),join(root,'alias.txt'));
  symlinkSync('.npmrc',join(root,'symlink.txt'));
  put(root,'tests/probe.test.cjs',`const {test}=require('node:test');const fs=require('node:fs');
    const fsp=require('node:fs/promises');const path=require('node:path');
    const p=path.join(__dirname,'../.npmrc');
    const denied=fn=>{let yes=false;try{fn()}catch{yes=true}if(!yes)throw Error('unguarded')};
    test('caught before original',async()=>{
      denied(()=>fs.readFileSync(p));denied(()=>fs.openSync(p,'r'));
      denied(()=>fs.createReadStream(p));denied(()=>require.resolve('../.npmrc'));
      denied(()=>fs.readFileSync(path.join(__dirname,'../alias.txt')));
      denied(()=>fs.readFileSync(path.join(__dirname,'../symlink.txt')));
      let yes=false;try{await fsp.readFile(p)}catch{yes=true}if(!yes)throw Error('unguarded promise');
    });\n`);
  const spy=join(out,'spy.cjs');
  writeFileSync(spy,`const fs=require('node:fs');const fsp=require('node:fs/promises');
    const path=require('node:path');const targets=new Set(JSON.parse(process.env.CUPEL_SPY_TARGETS));
    const log=fs.openSync(process.env.CUPEL_SPY_LOG,'a');const write=fs.writeSync.bind(fs);
    const wraps=[[fs,'readFileSync'],[fs,'openSync'],[fs,'createReadStream'],
      [fsp,'readFile'],[fsp,'open']];
    for(const [object,name] of wraps){const original=object[name];object[name]=function(p,...args){
      if(typeof p==='string'&&targets.has(path.resolve(p)))write(log,name+'\\n');
      return original.call(this,p,...args)};}
    require('node:module').syncBuiltinESMExports();\n`);
  const trace=join(out,'trace.jsonl'),log=join(out,'original-calls.txt');
  writeFileSync(trace,'');writeFileSync(log,'');
  const env={CI:'1',NO_COLOR:'1',TZ:'UTC',LANG:'C',CUPEL_ROOT:root,
    CUPEL_INPUT_POLICY:'express-root-npmrc-opaque-v1',CUPEL_OPAQUE_TRACE:trace,
    CUPEL_SPY_TARGETS:JSON.stringify(['.npmrc','alias.txt','symlink.txt'].map(name=>join(root,name))),
    CUPEL_SPY_LOG:log};
  const result=spawnSync(nodePath,[`--require=${spy}`,`--require=${join(profile,'opaque-guard.cjs')}`,
    '--test',join(root,'tests/probe.test.cjs')],{cwd:root,env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.equal(readFileSync(log,'utf8'),'','original content APIs must not see opaque path');
  const guard=readFileSync(trace,'utf8');
  assert.ok(guard.includes('opaque-denial'));
  assert.ok(!guard.includes('DUMMY_TEST_VALUE_ONLY'));
});
