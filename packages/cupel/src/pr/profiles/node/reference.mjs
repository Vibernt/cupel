import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cmp} from '../../../engine/order.mjs';
import {globMatches} from '../../../engine/match.mjs';
import {profileRequestSnapshot, runtimeVersion, fixedEnv} from './snapshot.mjs';
import {nodeProfileProducerProof} from '../../producer.mjs';
import {referenceRows} from './reference-results.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const policy = 'readonly-normal-runner-reference-v1';
const safeFile = file => typeof file === 'string' && TEST_FILE.test(file) &&
  !file.startsWith('/') && !file.split('/').some(part => !part || part === '..' || part === '.');
const privateFile = file => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077))
    throw new Error(`reference output is not a private owned file: ${file}`);
  return readFileSync(file,'utf8');
};
const checkPrivateDir = directory => {
  if (realpathSync(directory) !== directory) throw new Error('reference output traverses a symlink');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077))
    throw new Error('reference output directory is not private');
};
const marker = (row, kind, role) => row.kind === kind && row.role === role;

export function verifyReferenceProcessProof(trace, expectedFiles, runnerPid, run) {
  let records;
  try { records = trace.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error('malformed or truncated reference process trace'); }
  if (!records.length || records.some(row => row.owner !== `reference-run-${run}`))
    throw new Error('foreign or empty reference process trace');
  const denials = records.filter(row => row.kind === 'unsupported');
  if (denials.length) throw new Error(`reference resource denial: ${denials.map(row => row.reason).join(',')}`);
  const ready = records.filter(row => row.kind === 'reference-ready');
  const exit = records.filter(row => row.kind === 'reference-exit');
  if (ready.length !== expectedFiles.size + 1 || exit.length !== ready.length ||
      !marker(ready[0], 'reference-ready', 'parent') ||
      !marker(exit.at(-1), 'reference-exit', 'parent'))
    throw new Error('missing or truncated reference process proof');
  const parent = ready[0];
  if (!Number.isSafeInteger(parent.pid) || parent.pid !== runnerPid ||
      parent.file !== null || parent.context !== null ||
      exit.at(-1).pid !== parent.pid)
    throw new Error('invalid reference parent proof');
  const children = ready.slice(1), owners = new Set(), pids = new Set();
  for (const row of children) {
    if (row.role !== 'child' || row.context !== 'child-v8' || row.ppid !== parent.pid ||
        !expectedFiles.has(row.file) || owners.has(row.file) || pids.has(row.pid) ||
        !Number.isSafeInteger(row.pid))
      throw new Error('foreign, duplicate or missing reference child proof');
    owners.add(row.file); pids.add(row.pid);
    const closed = exit.filter(item => item.role === 'child' && item.pid === row.pid &&
      item.file === row.file && item.ppid === parent.pid && item.context === 'child-v8');
    if (closed.length !== 1) throw new Error('missing reference child completion proof');
  }
  if (owners.size !== expectedFiles.size ||
      [...expectedFiles].some(file => !owners.has(file)))
    throw new Error('missing reference child owner');
  return {run,complete:true,expectedFiles:[...expectedFiles].sort(cmp),
    seenFiles:[...owners].sort(cmp),parentPid:parent.pid,
    childPids:[...pids].sort((a,b)=>a-b),denials:[]};
}

/** Two independent complete normal node --test runs for profile eligibility. */
export function auditNodeReference({root, files, out, config = {}, nodePath = process.execPath,
  inputPolicy = 'strict-v1', expectedProducerHash, expectedIdentity} = {}) {
  const started = performance.now();
  if (!root || !out || !Array.isArray(files) || !files.length)
    throw new Error('reference requires root, private output and complete test files');
  root = resolve(root); out = resolve(out);
  if (out === root || out.startsWith(root + sep) || existsSync(out))
    throw new Error('reference requires fresh output outside subject root');
  const runner = config?.runners?.node ?? {};
  if (runner.prepare || runner.env) throw new Error('reference refuses runner prepare or env overrides');
  const selected = [...new Set(files)].sort(cmp);
  if (selected.length !== files.length || selected.some(file =>
      !safeFile(file) || !globMatches(runner.tests ?? 'tests/**/*.test.mjs',file)))
    throw new Error('reference files differ from locked runner configuration');
  const version = runtimeVersion(nodePath);
  if (version !== '26.7.0')
    throw new Error(`reference requires verified Node 26.7.0; got ${version}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedProducerHash ?? '') ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('reference producer differs from independently trusted pin');
  const before = profileRequestSnapshot({root,files:selected,version,inputPolicy});
  const discovered = Object.keys(before.manifest).filter(file => TEST_FILE.test(file) &&
    globMatches(runner.tests ?? 'tests/**/*.test.mjs',file)).sort(cmp);
  if (!same(selected, discovered)) throw new Error('reference requires complete test inventory');
  const expectedKeys = ['inputManifestHash','dependencyLockHash','producerHash',
    'configHash','profileRuntimeHash'];
  if (!expectedIdentity || expectedKeys.some(key => expectedIdentity[key] !== before.identity[key]))
    throw new Error('reference differs from expected fresh profile identity');
  const identity = {inputManifestHash:before.identity.inputManifestHash,
    dependencyLockHash:before.identity.dependencyLockHash,
    producerHash:before.identity.producerHash,runtimeVersion:version,
    policyHash:hash(JSON.stringify({policy,version,inputPolicy,files:selected,env:fixedEnv,
      configHash:before.identity.configHash,permission:'node26-child-process-cooperative',
      defaultIsolation:true,coverage:false,inspector:false}))};
  mkdirSync(out,{mode:0o700}); checkPrivateDir(out);
  const runRows = [], processProofs = [], executionMs = [];
  for (let run = 0; run < 2; run++) {
    const current = profileRequestSnapshot({root,files:selected,version,inputPolicy});
    if (!same(current.manifest,before.manifest) ||
        !same(current.dependencyLock,before.dependencyLock) ||
        !same(current.identity,before.identity) ||
        nodeProfileProducerProof().producerHash !== expectedProducerHash)
      throw new Error('reference input, dependencies or producer changed before run');
    const runOut = join(out,`run-${run}`);
    mkdirSync(runOut,{mode:0o700}); checkPrivateDir(runOut);
    mkdirSync(join(runOut,'subject-tmp'),{mode:0o700});
    const trace = join(runOut,'events.jsonl');
    writeFileSync(trace,'',{mode:0o600,flag:'wx'});
    const env = {...fixedEnv, HOME:join(runOut,'subject-tmp'),TMPDIR:join(runOut,'subject-tmp'),
      CUPEL_ROOT:root,CUPEL_PRIVATE_TMP:runOut,CUPEL_OWNER:`reference-run-${run}`,
      CUPEL_OWNER_FILES:selected.join('\n'),CUPEL_INPUT_POLICY:current.inputPolicy,
      CUPEL_INPUTS:JSON.stringify(Object.keys(current.manifest)),
      CUPEL_LOCKED_PACKAGES:JSON.stringify(Object.keys(current.dependencyLock.packages))};
    const relativeOut = relative(root,runOut);
    const relativeRuntime = relative(root,here);
    const args = ['--permission','--allow-child-process','--disable-sigusr1',
      '--allow-fs-read=.',`--allow-fs-read=${relativeRuntime}`,
      `--allow-fs-read=${relativeOut}`,
      `--allow-fs-write=${relativeOut}`,
      `--require=${join(here,'reference-bootstrap.cjs')}`,'--test',
      `--test-reporter=${join(here,'reporter.mjs')}`,...selected];
    const runStarted = performance.now();
    const child = spawnSync(nodePath,args,{cwd:root,env,encoding:'utf8',
      timeout:30000,maxBuffer:8 << 20});
    executionMs.push(Math.round(performance.now()-runStarted));
    writeFileSync(join(runOut,'runner.out'),`${child.stdout ?? ''}\n${child.stderr ?? ''}`,
      {mode:0o600,flag:'wx'});
    if (child.error || child.signal || child.status === null)
      throw new Error(`reference runner incomplete: ${child.error?.message ?? child.signal}`);
    checkPrivateDir(out); checkPrivateDir(runOut);
    checkPrivateDir(join(runOut,'subject-tmp'));
    const proofRecord = verifyReferenceProcessProof(privateFile(trace),new Set(selected),child.pid,run);
    const rows = referenceRows(child.stdout ?? '',root,new Set(selected));
    if (child.status !== 0 && !rows.some(row => row.status === 'failed'))
      throw new Error(`reference runner exited ${child.status} without reported failure`);
    if (child.status === 0 && rows.some(row => row.status === 'failed'))
      throw new Error('reference runner reported failure with successful exit');
    const after = profileRequestSnapshot({root,files:selected,version,inputPolicy});
    if (!same(after.manifest,before.manifest) ||
        !same(after.dependencyLock,before.dependencyLock) ||
        !same(after.identity,before.identity) ||
        nodeProfileProducerProof().producerHash !== expectedProducerHash)
      throw new Error('reference input, dependencies or producer changed after run');
    runRows.push(rows); processProofs.push(proofRecord);
  }
  return {kind:'complete',mode:policy,inputPolicy,fullFiles:discovered,runRows,processProofs,
    identity,costs:{totalMs:Math.round(performance.now()-started),executionMs}};
}
