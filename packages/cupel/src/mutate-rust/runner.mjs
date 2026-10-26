import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { lines } from '../engine/lines.mjs';
import { materializeGraph } from './graph.mjs';
import { refuse } from './errors.mjs';
import { run } from './process.mjs';
import { baselineMatches, classify, invalidCompile, parseResults } from './results.mjs';
const CARGO = '/opt/homebrew/bin/cargo';
const RUSTC = '/opt/homebrew/bin/rustc';
const RUSTDOC = '/opt/homebrew/bin/rustdoc';
const contains = (value,line) => lines(value ?? '').some(([a,b]) => a<=line && line<=b);
export function coveredByInput(input,site) {
  return ['byTest','byFile','setup'].some((key) => Object.values(input.coverage[key] ?? {}).some((row) => contains(row[site.source],site.line)));
}
export class RustSession {
  constructor(inventory,input,deadline,metrics) {
    this.inventory=inventory; this.input=input; this.root=inventory.root; this.deadline=deadline; this.metrics=metrics; this.sequence=0;
    mkdirSync(join(this.root,'.scratch'),{recursive:true}); this.scratch=mkdtempSync(join(this.root,'.scratch','cupel-mutate-rust-'));
    for (const dir of ['home','cargo-home','tmp']) mkdirSync(join(this.scratch,dir));
    this.env={ PATH:`${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, HOME:join(this.scratch,'home'), TMPDIR:join(this.scratch,'tmp'), LANG:'C', LC_ALL:'C',
      CARGO_HOME:join(this.scratch,'cargo-home'), CARGO_TARGET_DIR:join(this.scratch,'baseline-target'), CARGO_NET_OFFLINE:'true', CARGO_TERM_COLOR:'never', RUSTC,RUSTDOC };
    this.wrapper=join(this.scratch,'wrapper.mjs'); copyFileSync(fileURLToPath(new URL('./wrapper.mjs',import.meta.url)),this.wrapper); chmodSync(this.wrapper,0o755);
  }
  close() { rmSync(this.scratch,{recursive:true,force:true}); }
  remaining() { return Math.max(0,this.deadline-performance.now()); }
  async guarded(command,args,env=this.env,timeoutMs=this.remaining()) {
    this.inventory.assertFresh(); let result;
    try { result=await run(command,args,{root:this.root,env,timeoutMs:Math.max(1,timeoutMs)}); }
    finally { this.inventory.assertFresh(); }
    if (this.metrics) this.metrics.commands=(this.metrics.commands??0)+1;
    return result;
  }
  async prepare() {
    const rust=await this.guarded(RUSTC,['-vV']); const cargo=await this.guarded(CARGO,['--version']);
    if (rust.status!==0 || cargo.status!==0 || !/^release: 1\.97\.1$/m.test(rust.stdout) || !/^commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452$/m.test(rust.stdout) || !/^host: aarch64-apple-darwin$/m.test(rust.stdout) || !/^cargo 1\.97\.1 \(c980f4866 2026-06-30\) \(Homebrew\)\s*$/.test(cargo.stdout)) refuse('unsupported-rust-runtime','Rust profile requires fixed Homebrew Rust/Cargo 1.97.1 on aarch64-apple-darwin');
    if (this.input.runtime?.name!=='rust' || this.input.runtime.version!=='1.97.1') refuse('rust-runtime','Rust runtime differs from canonical collected input');
    await this.probeBaseline();
  }
  async module(env=this.env,timeoutMs=this.remaining()) {
    const result=await this.guarded(CARGO,['test','--offline','--locked','--','--test-threads=1'],env,timeoutMs);
    let statuses=new Map();
    if (!result.signal && !result.timedOut) { try { statuses=parseResults(result.stdout,this.inventory); } catch (error) { if (env===this.env) throw error; } }
    return {result,statuses};
  }
  async probeBaseline() {
    const {result,statuses}=await this.module(); baselineMatches(this.input,result,statuses); this.baselineMs=result.wallMs;
  }
  proof(log,spec) {
    if (!existsSync(log)) refuse('rust-compile-proof','Cargo compiled no wrapped crate input');
    const entries=readFileSync(log,'utf8').trim().split('\n').map((line)=>JSON.parse(line));
    if (!entries.some((entry)=>entry.test)) refuse('rust-compile-proof','wrapper did not compile library test harness');
    for (const entry of entries) {
      const expected=entry.original.map((arg)=>arg===entry.root?spec.graph.root:arg);
      for (const [from,to] of spec.graph.mappings) expected.push(`--remap-path-prefix=${from}=${to}`);
      if (entry.compiler!==RUSTC || !['src/lib.rs',`${this.root}/src/lib.rs`].includes(entry.root) || JSON.stringify(expected)!==JSON.stringify(entry.args)) refuse('rust-compile-proof','wrapper invocation differs from exact approved graph substitution');
    }
  }
  async compile(env,site,backing,log,spec) {
    const result=await this.guarded(CARGO,['test','--offline','--locked','--no-run','--message-format=json'],env);
    if (result.timedOut) return 'cut';
    if (result.status!==0 || result.signal) {
      const probe=await this.guarded(CARGO,['test','--offline','--locked','--no-run','--message-format=json']);
      if (probe.status!==0 || probe.signal || probe.timedOut) refuse('environment','known-good Cargo compile failed');
      if (!invalidCompile(result,site.source,backing)) refuse('environment',`Cargo compile failed without a target type/syntax diagnostic: ${result.stderr.trim()}`);
      return 'invalid';
    }
    this.proof(log,spec); return 'valid';
  }
  async check(site) {
    if (!coveredByInput(this.input,site)) return {status:'no-coverage',killedBy:[]};
    if (this.remaining()<1) return null;
    const dir=join(this.scratch,`mutant-${++this.sequence}`); mkdirSync(dir);
    const graph=materializeGraph(this.inventory,join(dir,'graph'),site);
    const log=join(dir,'wrapper.jsonl'); const spec={project:this.root,compiler:RUSTC,graph,log};
    const specPath=join(dir,'spec.json'); writeFileSync(specPath,JSON.stringify(spec));
    const env={...this.env,CARGO_TARGET_DIR:join(dir,'target'),RUSTC_WRAPPER:this.wrapper,CUPEL_RUST_WRAPPER_SPEC:specPath};
    try {
      const kind=await this.compile(env,site,graph.mappings.find(([,file])=>file===site.source)[0],log,spec);
      if (kind==='invalid') return {invalid:true};
      if (kind==='cut' || this.remaining()<1) return null;
      const trial=async(multiplier)=>{const {result,statuses}=await this.module(env,Math.min(this.remaining(),Math.max(1000,this.baselineMs*multiplier)));return classify(this.input,result,statuses);};
      let result=await trial(3);
      if (['survived','killed'].includes(result.status)) return result;
      if (this.remaining()<1) return null;
      await this.probeBaseline(); result=await trial(9);
      if (['error','timeout'].includes(result.status)) { if (this.remaining()<1) return null; await this.probeBaseline(); }
      return result;
    } finally { rmSync(dir,{recursive:true,force:true}); }
  }
}
