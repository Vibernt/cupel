import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readOnlyInputSnapshot } from './inputs.mjs';
import { loadLockedDependencies, observedDependencyEvidence } from './dependencies.mjs';
import {fixedEnv,profileRequestSnapshot,runtimeVersion} from './snapshot.mjs';
import {runOpaqueFull} from './opaque-full.mjs';
import { fileURLToPath } from 'node:url';
export {nodeProfileIdentity} from './snapshot.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const profileRoot=resolve(here);
const channels = () => ({imports:[],reads:[],probes:[],directories:[],writes:[],
  filesystemEvents:[],capabilities:[],unsupported:[]});
const unique = values => [...new Set(values)].sort();
const PROFILE_CAPABILITIES=['module-linkage','fs-sync','fs-async','fs-stream','fs-descriptor',
  'metadata','directory','readonly-boundary','unsupported-controls','fs-invocation-origin'];
function parseEvents(output,root) {
  const events = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const counts = new Map(); const rows=[];
  for (const event of events) {
    if (!['test:pass','test:fail'].includes(event.type)) continue;
    if (event.data.details?.type === 'suite') continue;
    const file = relative(root,event.data.file ?? '').split(sep).join('/');
    if (!file || file.startsWith('../')) throw new Error('test result lacks repository file identity');
    const key = `${file}:${event.data.name}`; const ordinal=(counts.get(key)??0)+1; counts.set(key,ordinal);
    rows.push({file,id:`${event.data.name}#${ordinal}`,
      status:event.data.skip||event.data.todo?'skipped':event.type==='test:fail'?'failed':'passed'});
  }
  if (!events.some(event=>event.type==='test:plan') || !rows.length)
    throw new Error('missing or incomplete test result stream');
  return rows;
}
function run(nodePath,args,root,env) {
  const start=performance.now();
  const result=spawnSync(nodePath,args,{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:8<<20});
  return {result,ms:Math.round(performance.now()-start)};
}
/** Experimental cooperative Node profile. Unsupported controls remain marked until verified. */
export function captureNodeProfile({mode='baseline',root,files,fullFiles,out,nodePath=process.execPath,
  binding,compareFull=true,requestSnapshot,inputPolicy='strict-v1'}) {
  if (requestSnapshot!==undefined) throw new Error('caller-provided Node profile snapshots are unsupported');
  if (!['baseline','selected-head'].includes(mode)) throw new Error(`unsupported Node profile mode: ${mode}`);
  if (mode==='selected-head' && (!fullFiles || !binding || compareFull===false))
    throw new Error('selected-head requires fullFiles and baseline binding');
  root=resolve(root); out=resolve(out);
  if (out===root || out.startsWith(root+sep)) throw new Error('private output must be outside fixture root');
  mkdirSync(out,{recursive:true});
  if (realpathSync(root)!==root || realpathSync(out)!==out) throw new Error('node profile refuses symlinked root or output');
  const version=runtimeVersion(nodePath);
  const universe=fullFiles??files;
  const snapshot=profileRequestSnapshot({root,files:universe,version,inputPolicy});
  const before=snapshot.manifest;
  inputPolicy=snapshot.inputPolicy;
  const dependencyLock=snapshot.dependencyLock;
  for (const file of files) if (!(file in before)) throw new Error(`missing declared test file: ${file}`);
  for (const file of universe) if (!(file in before)) throw new Error(`missing original test file: ${file}`);
  const policy=fixedEnv;
  const identity=snapshot.identity;
  if (mode==='selected-head') for (const name of ['baselineConfigHash','baselineParity',
      'environmentPolicyHash','dependencyLockHash','profileRuntimeHash','dependencyEvidence'])
    if (!Object.hasOwn(binding,name)) throw new Error(`selected-head missing baseline ${name}`);
  if (mode==='selected-head' && (binding.baselineParity!==true ||
      !/^sha256:[0-9a-f]{64}$/.test(binding.baselineConfigHash)))
    throw new Error('selected-head baseline parity/config proof is invalid');
  if (mode==='selected-head' && inputPolicy!=='strict-v1' && binding.baselinePrivacyGuardedFull!==true)
    throw new Error('selected-head requires verified privacy-guarded full baseline');
  if (mode==='baseline' && binding?.configHash && binding.configHash!==identity.configHash)
    throw new Error('caller config hash does not match actual Node profile');
  if (mode==='selected-head' && binding?.headConfigHash && binding.headConfigHash!==identity.configHash)
    throw new Error('caller head config hash does not match actual Node profile');
  if (binding?.environmentPolicyHash && binding.environmentPolicyHash!==identity.environmentPolicyHash)
    throw new Error('caller environment policy hash does not match actual Node profile');
  if (binding?.dependencyLockHash && binding.dependencyLockHash!==identity.dependencyLockHash)
    throw new Error('caller dependency lock hash does not match actual Node profile');
  if (binding?.profileRuntimeHash && binding.profileRuntimeHash!==identity.profileRuntimeHash)
    throw new Error('caller profile runtime hash does not match actual Node profile');
  if (mode==='selected-head') {
    const current=observedDependencyEvidence(root,Object.keys(binding.dependencyEvidence),dependencyLock);
    if (JSON.stringify(current)!==JSON.stringify(binding.dependencyEvidence))
      throw new Error('baseline dependency bytes changed before selected-head execution');
  }
  const reporter=join(here,'reporter.mjs');
  const ordinary=mode==='baseline' && compareFull ?
    inputPolicy==='strict-v1' ? run(nodePath,['--test',`--test-reporter=${reporter}`,...files],root,policy) :
      runOpaqueFull({nodePath,root,here,files,out,env:policy}) : null;
  const ordinaryRows=ordinary ? parseEvents(ordinary.result.stdout,root) : [];
  const sidecar={version:'cupel-pr-dependencies/1',runner:{name:'node',version},runtime:{name:'node',version},
    execution:{mode,isolation:'node-readonly-files-v1',profile:'node-readonly-files-v1',
      inputPolicy,opaqueRootNpmrc:snapshot.opaqueRootNpmrc,
      configHash:identity.configHash,environmentPolicyHash:identity.environmentPolicyHash,
      inputManifestHash:identity.inputManifestHash,dependencyLockHash:identity.dependencyLockHash,
      profileRuntimeHash:identity.profileRuntimeHash,
      ...(mode==='selected-head'?{baselineConfigHash:binding.baselineConfigHash}:{})},
    files:{},global:channels(),denials:[],nativeTypeScript:{files:{}},
    fullReferenceGuard:ordinary?.proof??null,
    completion:{expectedFiles:[...files].sort(),finishedFiles:[],errors:[]}};
  if (ordinary?.proof?.errors.length) sidecar.global.unsupported.push('privacy-guarded-full-incomplete');
  if (ordinary?.proof?.denials.length) sidecar.global.unsupported.push('privacy-guarded-full-denial');
  const timings=[]; const constrainedRows=[];
  for (const file of files) {
    const tmp=join(out,file.replaceAll('/','_'));
    mkdirSync(tmp,{recursive:true}); writeFileSync(join(tmp,'events.jsonl'),'');
    const env={...policy,HOME:tmp,TMPDIR:tmp,CUPEL_ROOT:root,CUPEL_OWNER:file,
      CUPEL_INPUT_POLICY:inputPolicy,
      CUPEL_INPUTS:JSON.stringify(Object.keys(before)),CUPEL_PRIVATE_TMP:tmp,
      CUPEL_LOCKED_PACKAGES:JSON.stringify(Object.keys(dependencyLock.packages))};
    const args=['--permission',`--allow-fs-read=${root}`,`--allow-fs-read=${here}`,
      `--allow-fs-read=${tmp}`,`--allow-fs-write=${tmp}`,`--require=${join(here,'bootstrap.cjs')}`,
      '--test','--experimental-test-isolation=none',`--test-reporter=${reporter}`,file];
    const {result,ms}=run(nodePath,args,root,env); timings.push({file,ms,exit:result.status});
    writeFileSync(join(tmp,'runner.out'),`${result.stdout??''}\n${result.stderr??''}`);
    const entry=channels(); sidecar.files[file]=entry;
    if (/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(`${result.stdout??''}\n${result.stderr??''}`))
      entry.unsupported.push('unsupported-native-typescript-syntax');
    let events=[];
    try { events=readFileSync(join(tmp,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)); }
    catch (error) { sidecar.completion.errors.push(`${file}: unreadable or malformed hook trace: ${error.message}`); }
    if (events[0]?.kind!=='bootstrap-ready' || events.at(-1)?.kind!=='bootstrap-exit')
      sidecar.completion.errors.push(`${file}: missing or truncated profile hook trace`);
    for (const event of events) {
      if (event.channel==='control') continue;
      if (event.kind==='unsupported') { const marker=`${event.reason}:${event.detail}`;
        entry.unsupported.push(marker); sidecar.denials.push({file,marker}); continue; }
      const channel=event.channel==='imports'?'imports':event.channel==='directories'?'directories':
        event.channel==='probes'?'probes':event.channel==='writes'?'writes':'reads';
      if (event.file && event.file!==profileRoot && !event.file.startsWith(profileRoot+sep) &&
          !event.file.startsWith(tmp)) {
        entry[channel].push(event.file);
        if (channel!=='imports') entry.filesystemEvents.push({channel,path:event.file,
          operation:event.kind,origin:event.origin??'unknown'});
      }
    }
    for (const key of ['imports','reads','probes','directories','writes','unsupported']) entry[key]=unique(entry[key]);
    try { const rows=parseEvents(result.stdout,root);
      if (rows.some(row=>row.file!==file)) throw new Error('foreign file result');
      constrainedRows.push(...rows); sidecar.completion.finishedFiles.push(file);
    } catch (error) { sidecar.completion.errors.push(`${file}: ${error.message}; exit ${result.status}`); }
    entry.capabilities=unique([
      ...PROFILE_CAPABILITIES,
      entry.imports.some(path=>/\.(?:ts|mts|cts)$/.test(path))&&'native-typescript',
      [...entry.imports,...entry.reads,...entry.probes].some(path=>path.startsWith('node_modules/'))&&'locked-pure-js',
    ].filter(Boolean));
  }
  sidecar.completion.finishedFiles.sort();
  for (const entry of Object.values(sidecar.files)) for (const path of entry.imports)
    if (/\.(?:ts|mts|cts)$/.test(path)) {
      if (!before[path]) sidecar.global.unsupported.push(`missing-native-typescript-source:${path}`);
      else sidecar.nativeTypeScript.files[path]=before[path];
    }
  const postInput=readOnlyInputSnapshot(root,{nodeModules:'skip',inputPolicy});
  const after=postInput.files;
  if (JSON.stringify(before)!==JSON.stringify(after) ||
      postInput.opaqueRootNpmrc!==snapshot.opaqueRootNpmrc)
    sidecar.global.unsupported.push('changed-input-inventory');
  const afterLock=loadLockedDependencies(root);
  if (JSON.stringify(dependencyLock)!==JSON.stringify(afterLock))
    sidecar.global.unsupported.push('changed-dependency-lock');
  const observed=Object.values(sidecar.files).flatMap(entry=>[
    ...entry.imports,...entry.reads,...entry.probes,...entry.directories]);
  try { sidecar.dependencies={lockHash:dependencyLock.lockHash,
      files:observedDependencyEvidence(root,observed,afterLock)};
    if (mode==='selected-head') {
      const postBaseline=observedDependencyEvidence(root,Object.keys(binding.dependencyEvidence),afterLock);
      if (JSON.stringify(postBaseline)!==JSON.stringify(binding.dependencyEvidence))
        sidecar.global.unsupported.push('baseline-dependency-bytes-changed-during-run');
    }
    if (mode==='selected-head' && Object.keys(sidecar.dependencies.files).some(path=>
        !Object.hasOwn(binding.dependencyEvidence,path)))
      sidecar.global.unsupported.push('new-dependency-observation');
    if (mode==='baseline' && binding?.dependencyEvidence &&
      JSON.stringify(binding.dependencyEvidence)!==JSON.stringify(sidecar.dependencies.files))
      sidecar.global.unsupported.push('changed-dependency-installation');
  } catch (error) { sidecar.global.unsupported.push(`invalid-dependency-evidence:${error.message}`); }
  const key = row => `${row.file}\0${row.id}\0${row.status}`;
  const parity=!!ordinary && JSON.stringify(ordinaryRows.map(key).sort())===JSON.stringify(constrainedRows.map(key).sort());
  if (mode==='baseline' && !ordinary) sidecar.global.unsupported.push('ordinary-full-not-run');
  else if (mode==='baseline' && !parity) sidecar.global.unsupported.push('ordinary-constrained-result-mismatch');
  if (mode==='baseline' && parity) for (const entry of Object.values(sidecar.files)) entry.capabilities.push('results-parity');
  if (mode==='selected-head') for (const entry of Object.values(sidecar.files)) entry.capabilities.push('baseline-parity-bound');
  if (inputPolicy!=='strict-v1' && mode==='baseline' && parity &&
      !sidecar.fullReferenceGuard.errors.length && !sidecar.fullReferenceGuard.denials.length)
    for (const entry of Object.values(sidecar.files)) entry.capabilities.push('privacy-guarded-full');
  if (inputPolicy!=='strict-v1' && mode==='selected-head')
    for (const entry of Object.values(sidecar.files)) entry.capabilities.push('baseline-privacy-bound');
  return {sidecar,timings,ordinaryFull:ordinary ? {ms:ordinary.ms,exit:ordinary.result.status,
    rows:ordinaryRows,privacyGuarded:inputPolicy!=='strict-v1'} : null,
    constrainedFull:{rows:constrainedRows,parity:mode==='baseline'?parity:null},
    selectedHead:mode==='selected-head'?{rows:constrainedRows,ms:timings.reduce((sum,row)=>sum+row.ms,0)}:null};
}
