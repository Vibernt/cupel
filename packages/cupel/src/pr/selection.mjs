import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cmp } from '../engine/order.mjs';
import { globMatches } from '../engine/match.mjs';
import { run as engineRun } from '../engine/index.mjs';
import { readOnlyInputSnapshot } from './profiles/node/inputs.mjs';
import policies from './profiles/node/input-policy.cjs';

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const sorted = values => [...values].sort(cmp);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE = /\.[cm]?[jt]sx?$/;
const schemas = Object.fromEntries(['input', 'config', 'report'].map(name => [name,
  JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'))]));

function criticalTestFiles(baseline) {
  const output = engineRun('label', { input: baseline.collection.input },
    baseline.config, {}, schemas);
  if (output.exit !== 0)
    throw new Error(`Node PR baseline critical labels unavailable: ${JSON.stringify(output.report.diagnostics)}`);
  return new Set(output.report.units.filter(unit => unit.tier === 'critical').map(unit => unit.file));
}

function observed(owner, source, baseline) {
  const input = baseline.collection.input;
  const channels = baseline.collection.observations?.[owner];
  if (!channels) throw new Error(`Node PR baseline trace missing owner: ${owner}`);
  if (input.tests.some(test => test.file === owner &&
      input.coverage.byTest?.[test.id]?.[source])) return true;
  if (input.coverage.setup?.[owner]?.[source]) return true;
  if (['imports', 'reads', 'probes'].some(channel => channels[channel]?.includes(source))) return true;
  return channels.directories?.some(path => path === '.' || source === path ||
    source.startsWith(`${path}/`)) ?? false;
}

const applicationObserver = channels => channels.filesystemEvents?.some(event =>
  event.origin !== 'loader' && ['reads', 'probes', 'directories'].includes(event.channel));

/** Decide a candidate scope from a fresh private HEAD inventory; execution must recheck it. */
export function selectNodeProfileHead({ root, baseline }) {
  if (!baseline?.git?.inputManifest ||
      ![policies.STRICT, policies.EXPRESS].includes(baseline.privacyPolicy) ||
      baseline.collection?.mode !== 'full' || !baseline.collection.observations)
    throw new Error('Node PR selection requires sealed full baseline evidence');
  const head = readOnlyInputSnapshot(root, { nodeModules: 'skip',
    inputPolicy: baseline.privacyPolicy });
  if (head.opaqueRootNpmrc !== baseline.git.opaqueRootNpmrc)
    throw new Error('Node PR opaque root presence changed');
  const base = baseline.git.inputManifest;
  const changed = sorted(new Set([...Object.keys(base), ...Object.keys(head.files)]
    .filter(path => base[path] !== head.files[path])));
  const runner = baseline.config?.runners?.node ?? {};
  const testPattern = runner.tests ?? 'tests/**/*.test.mjs';
  const headTests = sorted(Object.keys(head.files).filter(file =>
    TEST_FILE.test(file) && globMatches(testPattern, file)));
  const baseTests = new Set(baseline.collection.fullFiles);
  const critical = criticalTestFiles(baseline);
  const selected = new Set(critical);
  const noncode = [], changedCriticalTests = [], changedSources = [];
  for (const path of changed) {
    if (['cupel.json', 'package.json', 'package-lock.json'].includes(path))
      throw new Error(`Node PR changed runner configuration or installation: ${path}`);
    if (TEST_FILE.test(path) && globMatches(testPattern, path)) {
      if (!head.files[path]) throw new Error(`Node PR removed or renamed test file: ${path}`);
      if (critical.has(path)) changedCriticalTests.push(path);
      selected.add(path);
      continue;
    }
    if (Object.hasOwn(baseline.collection.input.sources, path)) {
      if (!base[path] || !head.files[path])
        throw new Error(`Node PR removed or renamed source: ${path}`);
      changedSources.push(path);
      continue;
    }
    if (CODE.test(path)) throw new Error(`Node PR unsupported changed code path: ${path}`);
    noncode.push(path);
  }
  if (noncode.length) {
    if (!headTests.length) throw new Error('Node PR profile-full route has no tests');
    return { route: 'profile-full', reason: `non-code changes: ${noncode.join(', ')}`,
      files: headTests, changed, changedSources,
      changedCriticalTests, headInventoryHash: digest(head.files) };
  }
  const owners = baseline.collection.fullFiles;
  for (const source of changedSources) {
    const covered = owners.filter(owner => observed(owner, source, baseline));
    if (!covered.length) throw new Error(`Node PR changed source has no proven owner: ${source}`);
    for (const owner of covered) selected.add(owner);
  }
  if (changed.length)
    for (const owner of owners) if (applicationObserver(baseline.collection.observations[owner]))
      selected.add(owner);
  if (!selected.size) throw new Error('Node PR empty selective scope has no proof');
  for (const file of selected) if (!head.files[file])
    throw new Error(`Node PR selected test file missing: ${file}`);
  for (const file of baseTests) if (!head.files[file] && !changed.includes(file))
    throw new Error(`Node PR baseline test file missing: ${file}`);
  return { route: 'selected', reason: changed.length ? `changed: ${changed.join(', ')}` : 'clean control',
    files: sorted(selected), changed, changedSources,
    changedCriticalTests, headInventoryHash: digest(head.files) };
}
