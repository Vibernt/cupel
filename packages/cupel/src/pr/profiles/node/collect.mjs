import { mkdirSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { cmp } from '../../../engine/order.mjs';
import { globMatches } from '../../../engine/match.mjs';
import { runNodeProfileAttempt } from './attempt.mjs';
import { profileRequestSnapshot, runtimeVersion } from './snapshot.mjs';
import { nodeProfileProducerProof } from '../../producer.mjs';
import { profileSources, profileCoverage, sourceRows } from './input-lines.mjs';
import { profileTestRows } from './input-rows.mjs';
import { assertSupportedNodeProfileConfig } from '../../policy.mjs';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TIER_TAG = /\[(critical|standard|minor)\]/g;
const sortedObject = entries => Object.fromEntries([...entries].sort((a, b) => cmp(a[0], b[0])));
const parityRow = row => ({ id: row.canonicalId, file: row.file, name: row.name,
  status: row.status, tags: [...new Set([...row.name.matchAll(TIER_TAG)].map(match => match[1]))].sort(cmp) });
const observations = attempts => {
  const keys = ['imports', 'reads', 'probes', 'directories', 'writes'];
  const result = Object.fromEntries(keys.map(key =>
    [key, [...new Set(attempts.flatMap(attempt => attempt.channels[key]))].sort(cmp)]));
  result.filesystemEvents = [...new Map(attempts.flatMap(attempt =>
    attempt.channels.filesystemEvents.map(event => [JSON.stringify(event), event]))).values()];
  return result;
};

/** Collect a canonical node:test input using only completed v2 profile attempts. */
export function collectNodeProfile({ root, files, out, config = {}, runs = 2, recheck = [],
  nodePath = process.execPath, inputPolicy = 'strict-v1', expectedProducerHash,
  mode = 'full' }) {
  if (!root || !out || !Array.isArray(files) || !files.length ||
      !Number.isSafeInteger(runs) || runs < 2 || runs > 20)
    throw new Error('Node PR collection requires root, private output, files and 2–20 complete runs');
  if (recheck.length) throw new Error('Node PR recheck is not yet implemented under the v2 profile');
  if (!['full', 'selected'].includes(mode)) throw new Error('Node PR collection mode is unsupported');
  assertSupportedNodeProfileConfig(config);
  const runner = config?.runners?.node ?? {};
  if (runner.prepare || runner.env) throw new Error('Node PR refuses runner prepare or env overrides');
  root = resolve(root); out = resolve(out);
  if (out === root || out.startsWith(`${root}${sep}`)) throw new Error('private output must be outside subject root');
  const selected = [...new Set(files)].sort(cmp);
  if (selected.length !== files.length || selected.some(file =>
      typeof file !== 'string' || !TEST_FILE.test(file) || file.startsWith('/') ||
      file.split('/').some(part => part === '..' || !part) ||
      !globMatches(runner.tests ?? 'tests/**/*.test.mjs', file)))
    throw new Error('Node PR test file selection differs from locked runner configuration');
  const version = runtimeVersion(nodePath);
  if (version !== '26.7.0')
    throw new Error(`Node v2 selective profile requires verified Node 26.7.0; got ${version}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedProducerHash ?? '') ||
      nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR collection requires a matching independently trusted producer pin');
  const before = profileRequestSnapshot({ root, files: selected, version, inputPolicy });
  if (selected.some(file => !Object.hasOwn(before.manifest, file)))
    throw new Error('Node PR selected test file is absent from complete input manifest');
  const discovered = Object.keys(before.manifest).filter(file =>
    TEST_FILE.test(file) && globMatches(runner.tests ?? 'tests/**/*.test.mjs', file)).sort(cmp);
  if (mode === 'full' && !same(selected, discovered))
    throw new Error('Node PR full collection test inventory differs from locked runner discovery');
  const sources = profileSources(root, before.manifest, new Set(selected), config?.scope);
  mkdirSync(out);
  const perFile = [];
  const dependencies = new Map();
  let producer = null;
  for (const [index, file] of selected.entries()) {
    const attempts = [];
    let fileDependencies = null;
    for (let run = 0; run < runs; run++) {
      const attempt = runNodeProfileAttempt({ root, file, nodePath, inputPolicy,
        expectedProducerHash, expectedDependencies: fileDependencies,
        out: join(out, `file-${index}-run-${run}`) });
      if (attempt.kind !== 'complete')
        throw new Error(`Node PR collection refused ${file} run ${run + 1}: ${attempt.reasons.join('; ')}`);
      if (!same(attempt.identity.inputManifestHash, before.identity.inputManifestHash) ||
          !same(attempt.identity.dependencyLockHash, before.identity.dependencyLockHash))
        throw new Error('Node PR input or dependency identity changed between attempts');
      if (producer && !same(attempt.producer, producer)) throw new Error('Node PR producer changed between attempts');
      producer = attempt.producer;
      fileDependencies ??= attempt.dependencies;
      attempts.push(attempt);
    }
    for (const [path, hash] of Object.entries(fileDependencies)) {
      if (dependencies.has(path) && !same(dependencies.get(path), hash))
        throw new Error(`Node PR observed dependency changed between files: ${path}`);
      dependencies.set(path, hash);
    }
    perFile.push({ file, attempts, coverage: profileCoverage(attempts, sources),
      rows: profileTestRows(root, before.manifest, attempts, config),
      observations: observations(attempts) });
  }
  const after = profileRequestSnapshot({ root, files: selected, version, inputPolicy });
  if (!same(after.manifest, before.manifest) ||
      !same(after.dependencyLock, before.dependencyLock) ||
      !same(after.identity, before.identity))
    throw new Error('Node PR input, lock or profile identity changed during collection');
  if (nodeProfileProducerProof().producerHash !== expectedProducerHash)
    throw new Error('Node PR producer changed during collection');
  const tests = perFile.flatMap(item => item.rows.tests).sort((a, b) => cmp(a.id, b.id));
  const runRows = Array.from({ length: runs }, (_, index) =>
    perFile.flatMap(item => item.attempts[index].rows.map(parityRow)).sort((a, b) => cmp(a.id, b.id)));
  const coverage = { granularity: 'test',
    byTest: sortedObject(perFile.flatMap(item => Object.entries(item.coverage.byTest))),
    setup: sortedObject(perFile.flatMap(item => Object.entries(item.coverage.setup))),
    unstable: sortedObject(perFile.flatMap(item => Object.entries(item.coverage.unstable))) };
  const input = { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version },
    sources: sourceRows(sources), tests, coverage,
    brittleness: perFile.flatMap(item => item.rows.brittleness).sort((a, b) =>
      cmp(a.test, b.test) || cmp(a.kind, b.kind) || a.line - b.line),
    shapes: sortedObject(perFile.flatMap(item => Object.entries(item.rows.shapes))) };
  return { kind: 'complete', profile: 'node-readonly-files-v2', mode, inputPolicy,
    fullFiles: discovered, input,
    runRows,
    observations: sortedObject(perFile.map(item => [item.file, item.observations])),
    identity: before.identity, producer, dependencies: sortedObject(dependencies),
    attempts: perFile.flatMap(item => item.attempts.map(attempt => ({
      file: item.file, costs: attempt.costs, rows: attempt.rows.length }))) };
}
