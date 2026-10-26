import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { baseFiles, writeFiles } from '../s12/fixtures.mjs';
import { safeFileInventory } from './evidence-base.mjs';
import { digest, makeBundle, REQUIRED_CAPABILITIES } from './evidence.mjs';

const channels = () => ({ imports: [], reads: [], probes: [], directories: [], writes: [],
  capabilities: [...REQUIRED_CAPABILITIES.node], unsupported: [] });

export function fixture() {
  const root = mkdtempSync('/tmp/cupel-s12b-selector-');
  const baseRoot = join(root, 'base'); const headRoot = join(root, 'head');
  writeFiles(baseRoot, baseFiles('node'));
  cpSync(baseRoot, headRoot, { recursive: true });
  const inventory = safeFileInventory(baseRoot);
  const tests = ['core', 'critical', 'text', 'text-runtime', 'independent', 'config', 'setup', 'param']
    .map(name => ({ id: `tests/${name}.test.mjs::${name}`, file: `tests/${name}.test.mjs`, name,
      status: 'passed', tags: name === 'critical' ? ['critical'] : [] }));
  const input = { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '26.7.0' },
    sources: Object.fromEntries(Object.keys(inventory).filter(path => path.startsWith('src/'))
      .map(path => [path, { coverable: '1', hash: `sha256:${inventory[path]}` }])), tests,
    coverage: { granularity: 'test', byTest: {
      [tests[0].id]: { 'src/core.mjs': '1' }, [tests[3].id]: { 'src/text.mjs': '1' },
    }, byFile: {}, setup: { 'tests/setup.test.mjs': { 'src/setup.mjs': '1' } } } };
  const files = Object.fromEntries(tests.map(row => [row.file, channels()]));
  files['tests/text.test.mjs'].reads.push('src/text.mjs');
  files['tests/text-runtime.test.mjs'].imports.push('src/text.mjs');
  files['tests/config.test.mjs'].reads.push('config.json');
  const config = { runner: 'node', command: '/node' };
  const environmentPolicy = { CI: '1', secrets: 'excluded' };
  const sidecar = { version: 'cupel-pr-dependencies/1', runner: { name: 'node', version: '26.7.0' },
    runtime: { name: 'node', version: 'node 26.7.0' },
    execution: { isolation: 'experimental-fresh-process-per-file', configHash: digest(config),
      environmentPolicyHash: digest(environmentPolicy) }, files, global: channels(),
    completion: { expectedFiles: Object.keys(files), finishedFiles: Object.keys(files), errors: [] } };
  const args = { baseRoot, headRoot, runner: 'node', runnerVersion: '26.7.0',
    runtime: 'node 26.7.0', config, environmentPolicy,
    executionPolicy: 'experimental-fresh-process-per-file', baseCommit: 'base-commit',
    dependencyInstall: { complete: true, node: '26.7.0' },
    probe: { complete: true, version: '1', hash: 'probe-hash' } };
  const bundle = makeBundle({ ...args, input, sidecar });
  return { root, args, bundle, sidecar };
}

export function withFixture(fn) {
  const f = fixture();
  try { fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}
