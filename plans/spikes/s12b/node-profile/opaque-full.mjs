import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';

export function runOpaqueFull({nodePath,root,here,files,out,env}) {
  const trace=join(out,'opaque-full-trace.jsonl');writeFileSync(trace,'');
  const guardedEnv={...env,CUPEL_ROOT:root,CUPEL_INPUT_POLICY:'express-root-npmrc-opaque-v1',
    CUPEL_OPAQUE_TRACE:trace};
  const args=[`--require=${join(here,'opaque-guard.cjs')}`,'--test',
    `--test-reporter=${join(here,'reporter.mjs')}`,...files];
  const start=performance.now();
  const result=spawnSync(nodePath,args,{cwd:root,env:guardedEnv,encoding:'utf8',timeout:30000,maxBuffer:8<<20});
  return {result,ms:Math.round(performance.now()-start),
    proof:inspectOpaqueFullTrace(trace,files)};
}

/** Validate the separate privacy-only guard trace from the full Node test run. */
export function inspectOpaqueFullTrace(path,files) {
  const expectedFiles=[...files].sort();
  const proof={mode:'privacy-guarded',policy:'express-root-npmrc-opaque-v1',
    expectedFiles,finishedFiles:[],errors:[],denials:[]};
  let rows;
  try { rows=readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)); }
  catch(error) {proof.errors.push(`unreadable or malformed full guard trace: ${error.message}`);return proof;}
  const processes=new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || !['parent','test-child'].includes(row.role) ||
      !['opaque-ready','opaque-exit','opaque-denial'].includes(row.kind)) {
      proof.errors.push('invalid full guard event');continue;
    }
    if (row.kind==='opaque-denial') {
      proof.denials.push(`${row.owner??'parent'}:${row.reason}:${row.detail}`);continue;
    }
    const state=processes.get(row.pid)??{role:row.role,owner:row.owner,ready:0,exit:0};
    if (state.role!==row.role || state.owner!==row.owner) proof.errors.push('full guard process identity changed');
    if (row.kind==='opaque-ready') state.ready++;
    if (row.kind==='opaque-exit') state.exit++;
    processes.set(row.pid,state);
  }
  const owners=new Map();let parents=0;
  for (const state of processes.values()) {
    if (state.ready!==1 || state.exit!==1) proof.errors.push('missing or truncated full guard process trace');
    if (state.role==='parent') {parents++;if (state.owner!==null) proof.errors.push('full guard parent has owner');}
    else {
      if (!expectedFiles.includes(state.owner)) proof.errors.push(`foreign full guard owner: ${state.owner}`);
      owners.set(state.owner,(owners.get(state.owner)??0)+1);
      if (state.ready===1 && state.exit===1) proof.finishedFiles.push(state.owner);
    }
  }
  if (parents!==1) proof.errors.push(`full guard parent count ${parents}`);
  for (const file of expectedFiles) if (owners.get(file)!==1)
    proof.errors.push(`full guard owner count differs: ${file}`);
  proof.finishedFiles.sort();
  return proof;
}
