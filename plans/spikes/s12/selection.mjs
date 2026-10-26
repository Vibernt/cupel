import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run as engineRun } from '../../../packages/cupel/src/engine/index.mjs';

const schemas = Object.fromEntries(['input', 'config', 'report'].map((name) => [name,
  JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}.schema.json`, import.meta.url), 'utf8'))]));

const sha = (value) => createHash('sha256').update(value).digest('hex');
const ignored = new Set(['.git', '.scratch', 'node_modules', '__pycache__', '.pytest_cache']);
const source = (path) => /^src\/.+\.(?:[cm]?[jt]sx?|py)$/.test(path);
const testFile = (path) => /^tests\/(?:.+\.test\.[cm]?[jt]sx?|(?:.*\/)?test_.*\.py)$/.test(path);

export function fileInventory(root) {
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unsupported symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[relative(root, path).replaceAll('\\', '/')] = sha(readFileSync(path));
      else throw new Error(`unsupported file type: ${relative(root, path)}`);
    }
  }
  visit(root);
  return files;
}

const digest = (value) => sha(JSON.stringify(value));
const sorted = (values) => [...values].sort();
const refuse = (reason) => ({ kind: 'refuse', reason, files: [] });
const covered = (map, src) => Object.hasOwn(map ?? {}, src) && Boolean(map[src]);

function labelledCriticalFiles(input, tierConfig) {
  const result = engineRun('label', { input }, tierConfig, {}, schemas);
  if (result.exit !== 0) throw new Error(`baseline engine labels unavailable: ${JSON.stringify(result.report.diagnostics)}`);
  return sorted(new Set(result.report.units.filter((unit) => unit.tier === 'critical').map((unit) => unit.file)));
}

export function makeEvidence({ baseRoot, input, runner, runtime, config, tierConfig = {} }) {
  if (!input?.tests?.length || !input.coverage || !input.sources) throw new Error('missing baseline input inventory or coverage');
  if (input.tests.some((test) => test.status === 'failed')) throw new Error('baseline suite has failed tests');
  const ids = input.tests.map((test) => test.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate baseline test IDs');
  const files = fileInventory(baseRoot);
  for (const [path, value] of Object.entries(input.sources)) {
    if (!files[path]) throw new Error(`missing baseline source: ${path}`);
    if (value.hash && value.hash !== `sha256:${files[path]}`) throw new Error(`baseline source hash differs: ${path}`);
  }
  const testFiles = new Set(input.tests.map((test) => test.file));
  for (const path of testFiles) if (!files[path] || !testFile(path)) throw new Error(`unsupported or missing baseline test file: ${path}`);
  for (const id of Object.keys(input.coverage.byTest ?? {})) if (!ids.includes(id)) throw new Error(`coverage names unknown test: ${id}`);
  for (const path of [...Object.keys(input.coverage.byFile ?? {}), ...Object.keys(input.coverage.setup ?? {})])
    if (!testFiles.has(path)) throw new Error(`coverage names unknown test file: ${path}`);
  const criticalFiles = labelledCriticalFiles(input, tierConfig);
  return { input, criticalFiles, identity: { tree: digest(files), input: digest(input), tests: digest(sorted(ids)),
    runner, runtime, config: digest(config), tierConfig: digest(tierConfig), criticalFiles: digest(criticalFiles), files } };
}

export function select({ evidence, baseRoot, headRoot, runner, runtime, config, tierConfig = {} }) {
  if (!evidence?.identity || !evidence.input) return refuse('missing baseline evidence');
  let base; let head;
  try { base = fileInventory(baseRoot); head = fileInventory(headRoot); }
  catch (error) { return refuse(error.message); }
  const id = evidence.identity;
  if (id.tree !== digest(base)) return refuse('stale base tree');
  if (id.input !== digest(evidence.input) || id.tests !== digest(sorted(evidence.input.tests?.map((test) => test.id) ?? []))) return refuse('corrupt baseline input or test inventory');
  if (id.runner !== runner || id.runtime !== runtime || id.config !== digest(config) || id.tierConfig !== digest(tierConfig)) return refuse('runner, runtime or config identity changed');
  if (!evidence.input.coverage || !Array.isArray(evidence.input.tests)) return refuse('baseline coverage or tests missing');
  if (!Array.isArray(evidence.criticalFiles) || id.criticalFiles !== digest(evidence.criticalFiles)) return refuse('critical labels missing or corrupt');
  try { if (digest(labelledCriticalFiles(evidence.input, tierConfig)) !== id.criticalFiles) return refuse('critical labels differ from engine'); }
  catch (error) { return refuse(error.message); }
  const changed = sorted(new Set([...Object.keys(base), ...Object.keys(head)].filter((path) => base[path] !== head[path])));
  const criticalFiles = new Set(evidence.criticalFiles);
  const selected = new Set(criticalFiles);
  const nonCode = [];
  for (const path of changed) {
    if (testFile(path)) {
      if (!head[path]) return refuse(`removed test file: ${path}`);
      if (criticalFiles.has(path)) return refuse(`changed critical test file requires identity check: ${path}`);
      selected.add(path);
      continue;
    }
    if (source(path)) {
      if (!base[path] || !head[path]) return refuse(`new, removed or renamed source needs full mapping: ${path}`);
      if (!evidence.input.sources[path]) return refuse(`unknown source: ${path}`);
      let found = false;
      for (const test of evidence.input.tests) {
        const hit = covered(evidence.input.coverage.byTest?.[test.id], path) ||
          covered(evidence.input.coverage.byFile?.[test.file], path) ||
          covered(evidence.input.coverage.setup?.[test.file], path);
        if (hit) { selected.add(test.file); found = true; }
      }
      if (!found) return refuse(`changed source has no known executable coverage: ${path}`);
      continue;
    }
    if (/^(?:vite|vitest|jest)\.config\.[cm]?[jt]s$/.test(path) || path === 'pyproject.toml')
      { nonCode.push(path); continue; }
    if (/\.(?:[cm]?[jt]sx?|py)$/.test(path)) return refuse(`unsupported source or test path: ${path}`);
    nonCode.push(path);
  }
  if (nonCode.length) return { kind: 'full', reason: `non-code input changed: ${nonCode.join(', ')}`,
    files: sorted(Object.keys(head).filter(testFile)) };
  if (selected.size === 0) return refuse('empty selection has no proof of safety');
  for (const path of selected) if (!head[path]) return refuse(`selected test file missing: ${path}`);
  return { kind: 'selected', reason: changed.length ? `changed: ${changed.join(', ')}` : 'clean control', files: sorted(selected) };
}
