import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mutateRust, confirmRust } from '../src/mutate-rust/index.mjs';
import { RustInventory } from '../src/mutate-rust/inventory.mjs';
import { parseRust } from '../src/mutate-rust/grammar.mjs';
import { run } from '../src/mutate-rust/process.mjs';
import { classify, invalidCompile, parseResults } from '../src/mutate-rust/results.mjs';
import { RustSession } from '../src/mutate-rust/runner.mjs';
const scratchBase=resolve('.scratch/rust-mutation-tests');mkdirSync(scratchBase,{recursive:true});
const proof=resolve(import.meta.dirname,'fixtures/rust-mutation');
const sha=(bytes)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture() {
 const root=mkdtempSync(join(scratchBase,'case-'));mkdirSync(join(root,'src/outer'),{recursive:true});
 for(const file of ['Cargo.toml','Cargo.lock','src/lib.rs','src/outer.rs','src/outer/inner.rs'])copyFileSync(join(proof,file),join(root,file));
 let inner=readFileSync(join(root,'src/outer/inner.rs'),'utf8').replace('pub fn value() -> i32 { 1 }','pub fn value() -> i32 { 0 + 1 }');
 inner += '\npub fn identity(n: i32) -> i32 { n + 0 }\npub fn dormant(n: i32) -> i32 { n + 2 }\n';writeFileSync(join(root,'src/outer/inner.rs'),inner);
 let outer=readFileSync(join(root,'src/outer.rs'),'utf8');outer+='\npub fn identity(n: i32) -> i32 { inner::identity(n) }\n';writeFileSync(join(root,'src/outer.rs'),outer);
 let lib=readFileSync(join(root,'src/lib.rs'),'utf8');lib+='\n#[test]\nfn identity() { assert_eq!(outer::identity(3), 3); }\n';writeFileSync(join(root,'src/lib.rs'),lib);
 const files=['src/lib.rs','src/outer.rs','src/outer/inner.rs'];
 for(const file of files){
  const path=join(root,file);let text=readFileSync(path,'utf8');const anchor=file==='src/lib.rs'?'fn source_and_macro_pins() {':'pub fn source_pins() {';
  const module='cupel_rust_graph_proof'+(file==='src/lib.rs'?'':file==='src/outer.rs'?'::outer':'::outer::inner');
  const assertion=`    assert_eq!((file!(), module_path!(), line!(), column!()), (${JSON.stringify(file)}, ${JSON.stringify(module)}, LINE, COLUMN));`;
  text=text.replace(anchor,anchor+'\n'+assertion);
  const pinLine=text.split('\n').findIndex((line)=>line.includes('LINE, COLUMN'))+1;const pinColumn=text.split('\n')[pinLine-1].indexOf('column!')+1;
  text=text.replace('LINE, COLUMN',`${pinLine}, ${pinColumn}`);writeFileSync(path,text);
 }
 const currentInner=readFileSync(join(root,'src/outer/inner.rs'),'utf8');
 const input={spec:'cupel-spec/1',kind:'input',runtime:{name:'rust',version:'1.97.1'},sources:Object.fromEntries(files.map((f)=>[f,{hash:sha(readFileSync(join(root,f))),coverable:`1-${readFileSync(join(root,f),'utf8').split('\n').length}`} ])),
 tests:['behavior','identity','source_and_macro_pins'].map((name)=>({id:`src/lib.rs::${name}`,file:'src/lib.rs',name,status:'passed',durationsMs:[1]})),coverage:{granularity:'test',byTest:{'src/lib.rs::behavior':{'src/outer/inner.rs':'1'},'src/lib.rs::identity':{'src/outer/inner.rs':String(currentInner.split('\n').findIndex((l)=>l.includes('fn identity'))+1)},'src/lib.rs::source_and_macro_pins':{}},setup:{},rechecked:['behavior','identity','source_and_macro_pins'].map((n)=>`src/lib.rs::${n}`)},brittleness:[],shapes:{}};
 return {root,input,inner};
}
const config={mutation:{maxMutants:10,maxSeconds:120,seed:7}};
test('real bounded Rust graph: behavior kill, executed survivor, no coverage and pristine source pins',async()=>{
 const {root,input}=fixture();const before=Object.fromEntries(Object.keys(input.sources).map((f)=>[f,sha(readFileSync(join(root,f)))]));const metrics={};
 const result=await mutateRust({root,input,config,scope:{changed:{'src/outer/inner.rs':input.sources['src/outer/inner.rs'].coverable}},metrics});
 assert.equal(result.mutants.length,3);assert.deepEqual(result.mutants.map((r)=>r.status),['killed','survived','no-coverage']);
 assert.deepEqual(result.mutants[0].killedBy,['src/lib.rs::behavior']);
 assert.ok(result.mutants.every((r)=>!r.killedBy?.includes('src/lib.rs::source_and_macro_pins')));
 const confirmed=await confirmRust({root,input,mutation:result,ids:[result.mutants[1].id],config});assert.equal(confirmed.mutants[1].status,'survived');
 assert.deepEqual(Object.fromEntries(Object.keys(input.sources).map((f)=>[f,sha(readFileSync(join(root,f)))])),before);
 assert.ok(metrics.commands>=11);console.log(JSON.stringify({rustMutants:result.mutants.map((m)=>m.status),commands:metrics.commands}));
});
test('fail-closed grammar rejects unmodeled Rust syntax and macro channels',()=>{
 for(const text of ['include!("x.rs");','#[cfg(test)] mod tests {}','#[path="x.rs"] mod x;','macro_rules! x { () => {} }','extern "C" {}','pub struct S;','fn x() { custom!(); }','fn x() { std::process::Command::new("rustc"); }','mod x; fn y() {}','fn x<T>() {}','fn x() { let x = r"foo"; }','fn x() { let x = |a| a; }','fn x() { println!("{}", std::env::var("HOME")); }','fn x() { include_str!("../private.rs"); }']) assert.throws(()=>parseRust(text,'src/lib.rs'),{code:'unsupported-rust-syntax'},text);
});
test('metadata, manifest, hash and incomplete inventory refusals happen explicitly',()=>{
 for(const [name,change,code] of [
 ['hash',({input})=>input.sources['src/lib.rs'].hash='opaque','source-hash'],
 ['workspace',({root})=>writeFileSync(join(root,'Cargo.toml'),'[workspace]\nmembers = []\n'),'unsupported-rust-manifest'],
 ['build',({root})=>writeFileSync(join(root,'build.rs'),'fn main() {}'),'unsupported-rust-channel'],
 ['inventory',({input})=>input.tests.pop(),'isolation-mismatch'],
 ['private',({input})=>input.sources['src/secrets.rs']={hash:`sha256:${'0'.repeat(64)}`,coverable:'1'},'source-path'],
 ['symlink',({root,input})=>{symlinkSync(join(root,'src/lib.rs'),join(root,'src/z.rs'));input.sources['src/z.rs']={hash:sha(readFileSync(join(root,'src/lib.rs'))),coverable:'1'};},'source-path'],
 ['orphan',({root,input})=>{writeFileSync(join(root,'src/z.rs'),'fn z() {}');input.sources['src/z.rs']={hash:sha(Buffer.from('fn z() {}')),coverable:'1'};},'unsupported-rust-graph'],
 ]){const f=fixture();change(f);const metrics={};assert.throws(()=>new RustInventory(f.root,f.input,metrics),{code},name);if(['private','symlink','hash','build'].includes(name))assert.equal(metrics.sourceReads??0,0,name);}
});
test('request-local source and test freshness across child boundaries',async()=>{
 for(const file of ['src/outer/inner.rs','src/lib.rs']) {
 const {root,input}=fixture();const inventory=new RustInventory(root,input);const session=new RustSession(inventory,input,performance.now()+30_000);
 try {await assert.rejects(session.guarded(process.execPath,['-e',`require('node:fs').appendFileSync(${JSON.stringify(join(root,file))},'\\n')`]),{code:'source-changed'});}finally{session.close();}
 }
});
test('timeout terminates inherited child process group without crediting a kill',async()=>{
 const dir=mkdtempSync(join(scratchBase,'timeout-'));const marker=join(dir,'late');
 const code=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),600)`)}],{stdio:'inherit'});setTimeout(()=>{},10000);`;
 const result=await run(process.execPath,['-e',code],{root:dir,env:process.env,timeoutMs:100});assert.equal(result.timedOut,true);
 await new Promise((resolve)=>setTimeout(resolve,800));assert.throws(()=>readFileSync(marker),{code:'ENOENT'});
});

test('real Cargo type-invalid replacement is excluded after unmutated compile probe',async()=>{
 const {root,input}=fixture();
 const file='src/outer/inner.rs'; const line=readFileSync(join(root,file),'utf8').split('\n').length;
 writeFileSync(join(root,file),readFileSync(join(root,file),'utf8')+'pub fn invalid() -> String { String::from("a") + "b" }\n');
 input.sources[file]={hash:sha(readFileSync(join(root,file))),coverable:`1-${line}`};input.coverage.byTest['src/lib.rs::behavior'][file]=String(line);
 const metrics={};const result=await mutateRust({root,input,config,scope:{changed:{[file]:[line]}},metrics});
 assert.deepEqual(result.mutants,[]);assert.equal(metrics.invalid,1);assert.equal(result.sampled,false);
});
test('deterministic caps keep only complete targeted units',async()=>{
 const {root,input}=fixture();const limited={mutation:{maxMutants:1,maxSeconds:120,seed:4}};
 const scope={targeted:['src/lib.rs::behavior','src/lib.rs::identity']};
 const a=await mutateRust({root,input,config:limited,scope});const b=await mutateRust({root,input,config:limited,scope});
 assert.deepEqual(a,b);assert.equal(a.mutants.length,1);assert.equal(a.sampled,true);assert.deepEqual(a.targeted,['src/lib.rs::behavior']);
});
test('historical confirmation refuses stale hash and current changed assertion source',async()=>{
 const {root,input}=fixture();const bad=structuredClone(input);bad.sources['src/lib.rs'].hash='sha256:'+ '0'.repeat(64);
 const mutation={mutants:[{id:'historic',source:'src/lib.rs',line:1,operator:'arithmetic-replacement',status:'survived'}],targeted:[],seed:1,sampled:false};
 await assert.rejects(confirmRust({root,input:bad,mutation,ids:['historic'],config}),{code:'source-changed'});
 writeFileSync(join(root,'src/lib.rs'),readFileSync(join(root,'src/lib.rs'),'utf8').replace('outer::value(), 1','outer::value(), 9'));
 await assert.rejects(mutateRust({root,input,config,scope:{changed:{'src/outer/inner.rs':[1]}}}),{code:'source-changed'});
});
test('crash, missing terminals and timeouts have no invented Rust killers',()=>{
 const input={tests:[{id:'a',status:'passed'},{id:'b',status:'passed'}]};
 for(const result of [{status:101,signal:null,timedOut:false},{status:null,signal:'SIGABRT',timedOut:false},{status:null,signal:'SIGKILL',timedOut:true}]) {
  const out=classify(input,result,new Map([['a','failed']]));assert.ok(['error','timeout'].includes(out.status));assert.deepEqual(out.killedBy,[]);
 }
 assert.throws(()=>parseResults('test unknown ... ok\n',{tests:new Map()}),{code:'rust-results'});
});

test('compiler-control environment and receipt accessors refuse before Cargo',async()=>{
 for(const accessor of ['std::env::var_os("RUSTC_WRAPPER")','std::env::var("CUPEL_RUST_WRAPPER_SPEC")','option_env!("RUSTC_WRAPPER")','env!("RUSTC_WRAPPER")','env!("CUPEL_RUST_WRAPPER_SPEC")']) {
  const {root,input}=fixture();const path=join(root,'src/lib.rs');writeFileSync(path,readFileSync(path,'utf8')+`\n#[test]\nfn observes_compile_environment() { let value = ${accessor}; }\n`);
  input.sources['src/lib.rs'].hash=sha(readFileSync(path));const metrics={};
  await assert.rejects(mutateRust({root,input,config,scope:{changed:{'src/outer/inner.rs':[1]}},metrics}),{code:'unsupported-rust-syntax'});assert.equal(metrics.commands??0,0);
 }
});

test('incomplete graph and unknown/invalid changed ranges refuse; empty ranges select nothing',async()=>{
 const {root,input}=fixture();const incomplete=structuredClone(input);delete incomplete.sources['src/outer/inner.rs'];for(const row of Object.values(incomplete.coverage.byTest))delete row['src/outer/inner.rs'];
 await assert.rejects(mutateRust({root,input:incomplete,config,scope:{changed:{'src/outer/inner.rs':'1'}}}),{code:'source-hash'});
 for(const changed of [{'src/missing.rs':'1'},{'src/outer/inner.rs':'wat'},{'src/outer/inner.rs':'9-1'},{'src/outer/inner.rs':[0]},{'src/outer/inner.rs':[1.5]},{'src/outer/inner.rs':null}])await assert.rejects(mutateRust({root,input,config,scope:{changed}}),{code:'scope'});
 const metrics={};const empty=await mutateRust({root,input,config,scope:{changed:{'src/outer/inner.rs':''}},metrics});assert.deepEqual(empty,{mutants:[],targeted:[],seed:7,sampled:false});assert.equal(metrics.commands??0,0);
});
test('direct Rust API refuses custom Cargo runner semantics',async()=>{
 const {root,input}=fixture();for(const runner of [{command:'custom test'},{collector:'custom'},{prepare:'custom'},{env:{RUSTFLAGS:'x'}},{args:[]},{project:'other'}])await assert.rejects(mutateRust({root,input,config:{runners:{cargo:runner}},scope:{critical:true}}),{code:'unsupported-rust-config'});
});

test('native source readers refuse external, computed, unpinned and aliased paths',async()=>{
 for(const expression of ['std::fs::read_to_string("README.md")','std::fs::read("/etc/hosts")','std::fs::read_to_string(String::from("src/") + "lib.rs")','std::fs::read_to_string','std::fs::read_to_string("src/missing.rs")']){
  const {root,input}=fixture();const path=join(root,'src/lib.rs');writeFileSync(path,readFileSync(path,'utf8')+`\n#[test]\nfn external_read() { let value = ${expression}; }\n`);input.sources['src/lib.rs'].hash=sha(readFileSync(path));const metrics={};
  await assert.rejects(mutateRust({root,input,config,scope:{changed:{'src/outer/inner.rs':[1]}},metrics}),(error)=>['unsupported-rust-syntax','unsupported-rust-channel'].includes(error.code));assert.equal(metrics.commands??0,0);
 }
});

test('compiler environment and ancestor Cargo config refuse before source reads',()=>{
 const {root,input}=fixture();
 for(const key of ['RUSTFLAGS','RUSTDOCFLAGS','RUSTC_WRAPPER','RUSTUP_TOOLCHAIN','CARGO_BUILD_RUSTC','CARGO_ENCODED_RUSTFLAGS']){
  const prior=process.env[key];process.env[key]='custom';const metrics={};
  try{assert.throws(()=>new RustInventory(root,input,metrics),{code:'unsupported-rust-environment'});assert.equal(metrics.sourceReads??0,0);}finally{if(prior===undefined)delete process.env[key];else process.env[key]=prior;}
 }
 mkdirSync(join(root,'.cargo'));writeFileSync(join(root,'.cargo/config.toml'),'not read');const metrics={};assert.throws(()=>new RustInventory(root,input,metrics),{code:'unsupported-rust-environment'});assert.equal(metrics.sourceReads??0,0);
});
test('compile infrastructure failures are never invalid-mutant exclusions',()=>{
 const diagnostic=(file,code='E0308')=>JSON.stringify({reason:'compiler-message',message:{level:'error',code:code?{code}:null,spans:[{file_name:file,is_primary:true}]}});
 for(const row of [{status:1,signal:null,timedOut:false,stdout:'',stderr:'disk full'},{status:1,signal:null,timedOut:false,stdout:diagnostic('src/unrelated.rs'),stderr:''},{status:1,signal:null,timedOut:false,stdout:diagnostic('src/lib.rs',null),stderr:''},{status:null,signal:'SIGSEGV',timedOut:false,stdout:diagnostic('src/lib.rs'),stderr:''},{status:null,signal:'SIGKILL',timedOut:true,stdout:diagnostic('src/lib.rs'),stderr:''}])assert.equal(invalidCompile(row,'src/lib.rs','scratch.rs'),false);
});
