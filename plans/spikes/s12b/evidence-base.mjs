import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { run as engineRun } from '../../../packages/cupel/src/engine/index.mjs';
import { readOnlyInputSnapshot } from './node-profile/inputs.mjs';

const schemas = Object.fromEntries(['input', 'config', 'report'].map(name => [name,
  JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}.schema.json`, import.meta.url), 'utf8'))]));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = values => [...values].sort();
const testFile = path => /^tests\/(?:.+\.test\.[cm]?[jt]sx?|(?:.*\/)?test_.*\.py)$/.test(path);
export const STRICT_INPUT_POLICY = 'strict-v1';
export const OPAQUE_NPMRC_POLICY = 'express-root-npmrc-opaque-v1';
export function normalizeInputPolicy(value = STRICT_INPUT_POLICY) {
  if (![STRICT_INPUT_POLICY, OPAQUE_NPMRC_POLICY].includes(value))
    throw new Error(`unsupported input privacy policy: ${value}`);
  return value;
}

/** Complete filename/type preflight before reading any fixture contents. */
export function safeInputSnapshot(root, options = {}) {
  const inputPolicy = normalizeInputPolicy(options.inputPolicy);
  const snapshot = readOnlyInputSnapshot(root, { nodeModules: 'skip', ...options, inputPolicy });
  if (!['absent', 'regular'].includes(snapshot.opaqueRootNpmrc))
    throw new Error('opaque root .npmrc descriptor invalid');
  const files = Object.fromEntries(Object.entries(snapshot.files).map(([path, hash]) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid inventory hash: ${path}`);
    return [path, hash.slice('sha256:'.length)];
  }));
  return { files, opaqueRootNpmrc: snapshot.opaqueRootNpmrc, inputPolicy };
}

export function safeFileInventory(root, options = {}) {
  return safeInputSnapshot(root, options).files;
}

function labelledCriticalFiles(input, tierConfig) {
  const result = engineRun('label', { input }, tierConfig, {}, schemas);
  if (result.exit !== 0)
    throw new Error(`baseline engine labels unavailable: ${JSON.stringify(result.report.diagnostics)}`);
  return sorted(new Set(result.report.units.filter(unit => unit.tier === 'critical').map(unit => unit.file)));
}

export function rebuildBaseEvidence({ input, runner, runtime, config, tierConfig = {} }, files) {
  if (!input?.tests?.length || !input.coverage || !input.sources)
    throw new Error('missing baseline input inventory or coverage');
  if (input.tests.some(test => test.status === 'failed')) throw new Error('baseline suite has failed tests');
  const ids = input.tests.map(test => test.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate baseline test IDs');
  for (const [path, value] of Object.entries(input.sources)) {
    if (!files[path]) throw new Error(`missing baseline source: ${path}`);
    if (value.hash && value.hash !== `sha256:${files[path]}`)
      throw new Error(`baseline source hash differs: ${path}`);
  }
  const testFiles = new Set(input.tests.map(test => test.file));
  for (const path of testFiles)
    if (!files[path] || !testFile(path)) throw new Error(`unsupported or missing baseline test file: ${path}`);
  for (const id of Object.keys(input.coverage.byTest ?? {}))
    if (!ids.includes(id)) throw new Error(`coverage names unknown test: ${id}`);
  for (const path of [...Object.keys(input.coverage.byFile ?? {}), ...Object.keys(input.coverage.setup ?? {})])
    if (!testFiles.has(path)) throw new Error(`coverage names unknown test file: ${path}`);
  const criticalFiles = labelledCriticalFiles(input, tierConfig);
  return { input, criticalFiles, identity: { tree: sha(files), input: sha(input), tests: sha(sorted(ids)),
    runner, runtime, config: sha(config), tierConfig: sha(tierConfig),
    criticalFiles: sha(criticalFiles), files } };
}

export function makeBaseEvidence(args) {
  return rebuildBaseEvidence(args, safeFileInventory(args.baseRoot,
    { inputPolicy: normalizeInputPolicy(args.inputPolicy) }));
}
