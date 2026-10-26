import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { observedDependencyEvidence, loadLockedDependencies } from './dependencies.mjs';
import { resultRows } from './events.mjs';
import { fixedEnv, profileRequestSnapshot, runtimeVersion } from './snapshot.mjs';
import { readOnlyInputSnapshot } from './inputs.mjs';
import { mutationPipeSpec } from './mutation-host.mjs';
import { verifyCoverageProof } from './coverage-proof.mjs';
import { nodeProfileProducerProof } from '../../producer.mjs';
import { profileTraceEvidence } from './trace-evidence.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One complete isolated file attempt. Every call reads fresh input and lock state. */
export function runNodeProfileAttempt({ root, file, out, nodePath = process.execPath,
  inputPolicy = 'strict-v1', mutationSpec = null, expectedDependencies = null,
  expectedProducerHash }) {
  const started = performance.now();
  root = resolve(root); out = resolve(out);
  if (out === root || out.startsWith(`${root}${sep}`)) throw new Error('private output must be outside subject root');
  if (existsSync(out)) throw new Error('profile attempt requires a fresh private output directory');
  mkdirSync(out);
  if (realpathSync(root) !== root || realpathSync(out) !== out) throw new Error('profile root or output is symlinked');
  const version = runtimeVersion(nodePath);
  if (version !== '26.7.0') throw new Error(`Node v2 selective profile requires verified Node 26.7.0; got ${version}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedProducerHash ?? ''))
    throw new Error('Node PR producer requires an independently trusted SHA-256 pin');
  const producer = nodeProfileProducerProof();
  if (producer.producerHash !== expectedProducerHash)
    throw new Error('Node PR producer differs from trusted pin before attempt');
  const pre = profileRequestSnapshot({ root, files: [file], version, inputPolicy });
  if (!Object.hasOwn(pre.manifest, file)) throw new Error(`missing declared Node test file: ${file}`);
  if (mutationSpec && (mutationSpec.version !== 'cupel-node-mutation-pipe/1' ||
      pre.manifest[mutationSpec.source] !== mutationSpec.originalHash))
    throw new Error('mutant source differs from fresh profile snapshot');
  if (mutationSpec) {
    const regenerated = mutationPipeSpec({ root, source: mutationSpec.source,
      sourceHash: mutationSpec.originalHash, mutantId: mutationSpec.mutant?.id });
    if (!same(regenerated, mutationSpec)) throw new Error('mutant pipe differs from regenerated source descriptor');
  }
  if (expectedDependencies) {
    const current = observedDependencyEvidence(root, Object.keys(expectedDependencies), pre.dependencyLock);
    if (!same(current, expectedDependencies)) throw new Error('baseline dependency bytes changed before attempt');
  }
  const trace = join(out, 'events.jsonl');
  writeFileSync(trace, '');
  const env = { ...fixedEnv, HOME: out, TMPDIR: out, CUPEL_ROOT: root, CUPEL_OWNER: file,
    CUPEL_INPUT_POLICY: pre.inputPolicy, CUPEL_INPUTS: JSON.stringify(Object.keys(pre.manifest)),
    CUPEL_INPUT_MANIFEST_HASH: pre.identity.inputManifestHash,
    CUPEL_PROFILE_COVERAGE: 'per-test-v1',
    CUPEL_PRIVATE_TMP: out, CUPEL_LOCKED_PACKAGES: JSON.stringify(Object.keys(pre.dependencyLock.packages)),
    ...(mutationSpec ? { CUPEL_MUTATION_PIPE: 'stdin-v1' } : {}) };
  const args = ['--permission', '--allow-inspector', '--disable-sigusr1',
    `--allow-fs-read=${root}`, `--allow-fs-read=${here}`,
    `--allow-fs-read=${out}`, `--allow-fs-write=${out}`,
    `--require=${join(here, 'bootstrap.cjs')}`, '--test', '--experimental-test-isolation=none',
    `--test-reporter=${join(here, 'reporter.mjs')}`, file];
  const childStarted = performance.now();
  const child = spawnSync(nodePath, args, { cwd: root, env,
    input: mutationSpec ? JSON.stringify(mutationSpec) : undefined,
    encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 });
  writeFileSync(join(out, 'runner.out'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
  const executionMs = Math.round(performance.now() - childStarted);
  const reasons = [];
  let traceRows = [], rows = [];
  try { traceRows = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { reasons.push(`malformed profile trace: ${error.message}`); }
  if (traceRows[0]?.kind !== 'bootstrap-ready' || traceRows.at(-1)?.kind !== 'bootstrap-exit')
    reasons.push('missing or truncated profile trace');
  let channels = null;
  try { channels = profileTraceEvidence(traceRows, { privateTmp: out }); }
  catch (error) { reasons.push(error.message); }
  const denials = traceRows.filter(row => row.kind === 'unsupported').map(row => `${row.reason}:${row.detail}`);
  if (denials.length) reasons.push(`profile denials: ${denials.join(', ')}`);
  if (mutationSpec && !traceRows.some(row => row.kind === 'mutant-loaded' &&
      row.id === mutationSpec.mutant.id && row.file === mutationSpec.source &&
      row.originalHash === mutationSpec.originalHash && row.replacementHash === mutationSpec.replacementHash))
    reasons.push('mutant was not loaded with expected identity');
  if (child.error || child.signal || child.status === null)
    reasons.push(`Node test process incomplete: ${child.error?.message ?? child.signal ?? child.status}`);
  try { rows = resultRows(child.stdout ?? '', root, file); }
  catch (error) { reasons.push(error.message); }
  if (child.status !== 0 && !rows.some(row => row.status === 'failed'))
    reasons.push(`Node process exited ${child.status} without a reported test failure`);
  let coverage = null;
  try { coverage = JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8')); }
  catch (error) { reasons.push(`missing or malformed per-test coverage: ${error.message}`); }
  let verifiedCoverage = null;
  if (coverage) {
    try { verifiedCoverage = verifyCoverageProof(coverage, { file,
      inputManifestHash: pre.identity.inputManifestHash, rows,
      sources: new Set(Object.keys(pre.manifest).filter(path =>
        /\.(?:[cm]?js|ts|mts|cts)$/.test(path) &&
        !/(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]s$/.test(path))) }); }
    catch (error) { reasons.push(error.message); }
  }
  if (traceRows.some(row => row.kind === 'coverage-error')) reasons.push('persistent coverage error');
  const post = readOnlyInputSnapshot(root, { nodeModules: 'skip', inputPolicy: pre.inputPolicy });
  if (!same(post.files, pre.manifest) || post.opaqueRootNpmrc !== pre.opaqueRootNpmrc)
    reasons.push('input inventory changed during profile attempt');
  const postLock = loadLockedDependencies(root);
  if (!same(postLock, pre.dependencyLock)) reasons.push('dependency lock changed during profile attempt');
  const observed = traceRows.filter(row => row.file && ['imports', 'repository-read'].includes(row.channel))
    .map(row => row.file);
  let dependencies = {};
  try {
    dependencies = observedDependencyEvidence(root, observed, postLock);
    if (expectedDependencies) {
      const historical = observedDependencyEvidence(root, Object.keys(expectedDependencies), postLock);
      if (!same(historical, expectedDependencies)) reasons.push('baseline dependency bytes changed during attempt');
      if (Object.keys(dependencies).some(path => !Object.hasOwn(expectedDependencies, path)))
        reasons.push('new dependency observed during profile attempt');
    }
  } catch (error) { reasons.push(`dependency evidence invalid: ${error.message}`); }
  if (nodeProfileProducerProof().producerHash !== expectedProducerHash)
    reasons.push('Node PR producer differs from trusted pin during attempt');
  const info = { profile: 'node-readonly-files-v2', file, runtime: version,
    producer, identity: pre.identity, rows, coverage, verifiedCoverage, channels,
    dependencies, denials,
    mutation: mutationSpec ? { id: mutationSpec.mutant.id, source: mutationSpec.source,
      loaded: !reasons.includes('mutant was not loaded with expected identity') } : null,
    exit: child.status, reasons,
    costs: { totalMs: Math.round(performance.now() - started), executionMs } };
  return { kind: reasons.length ? 'refuse' : 'complete', ...info };
}
