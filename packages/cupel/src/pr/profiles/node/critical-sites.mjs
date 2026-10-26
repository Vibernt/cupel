import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { effectiveConfig } from '../../../engine/config.mjs';
import { isCriticalSource } from '../../../engine/model.mjs';
import { parse } from '../../../engine/lines.mjs';
import { cmp } from '../../../engine/order.mjs';
import { sourceMutants } from '../../../mutate/sites.mjs';
import { applyMutant } from '../../../mutate/operators.mjs';
import { profileCandidateValidity } from './validity.mjs';
import { runtimeVersion } from './snapshot.mjs';

const configSchema = JSON.parse(readFileSync(new URL('../../../../schemas/config.schema.json', import.meta.url)));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const validLines = value => {
  const result = parse(value);
  if (result.malformed || result.bad.length) throw new Error('Node PR source line scope is malformed');
  return result.set;
};
const contains = (ranges, line) => ranges.some(([start, end]) => line >= start && line <= end);

function jsMode(root, manifest, source) {
  if (!source.endsWith('.js')) return null;
  let directory = dirname(source);
  while (true) {
    const path = directory === '.' ? 'package.json' : `${directory}/package.json`;
    // Source hashes are checked by the whole profile inventory. Read package metadata
    // only when it is a declared file in that inventory; callers must supply the manifest.
    if (Object.hasOwn(manifest, path)) {
      const bytes = readFileSync(join(root, path));
      if (sha(bytes) !== manifest[path]) throw new Error(`Node PR package metadata changed: ${path}`);
      const type = JSON.parse(bytes.toString('utf8')).type;
      if (type !== undefined && !['module', 'commonjs'].includes(type))
        throw new Error(`Node PR package type unsupported: ${path}`);
      return type === 'module' ? 'module' : 'commonjs';
    }
    if (directory === '.') return 'commonjs';
    directory = dirname(directory);
  }
}

/** Enumerate every syntactically valid critical site; refuse cap exhaustion. */
export function criticalProfileSites({ root, input, manifest, config = {},
  nodePath, changed = null }) {
  if (runtimeVersion(nodePath) !== '26.7.0')
    throw new Error('Node v2 critical sites require verified Node 26.7.0');
  if (!input?.sources || !input?.tests || !manifest ||
      input.tests.some(row => row.status === 'failed'))
    throw new Error('Node PR critical sites require a passing, pinned profile input');
  const cfg = effectiveConfig(config, configSchema);
  const candidates = [], filtered = [], invalid = [];
  for (const source of Object.keys(input.sources).sort(cmp)) {
    if (!isCriticalSource(source, cfg)) continue;
    if (changed && !Object.hasOwn(changed, source)) continue;
    if (/\.(?:jsx|tsx)$/.test(source)) throw new Error(`Node PR native profile cannot mutate JSX: ${source}`);
    const coverable = validLines(input.sources[source].coverable);
    const selected = changed ? validLines(changed[source]) : coverable;
    const bytes = readFileSync(join(root, source));
    if (sha(bytes) !== input.sources[source].hash || manifest[source] !== input.sources[source].hash)
      throw new Error(`Node PR critical source changed: ${source}`);
    const text = bytes.toString('utf8');
    if (/\.(?:ts|mts|cts)$/.test(source)) {
      try { stripTypeScriptTypes(text); }
      catch (error) { throw new Error(`Node PR native TypeScript source unsupported: ${source}: ${error.message}`); }
    }
    const generated = sourceMutants(root, source, text);
    if (!generated) throw new Error(`Node PR critical source parser unavailable: ${source}`);
    const mode = source.endsWith('.js') ? jsMode(root, manifest, source) : null;
    for (const mutant of generated) {
      if (!contains(coverable, mutant.line) || !contains(selected, mutant.line)) continue;
      if (mutant.filtered) { filtered.push({ id: mutant.id, reason: mutant.filtered }); continue; }
      candidates.push({ mutant, text: applyMutant(text, mutant), jsMode: mode });
    }
  }
  if (changed) for (const source of Object.keys(changed))
    if (!Object.hasOwn(input.sources, source) || !isCriticalSource(source, cfg))
      throw new Error(`Node PR changed critical source absent or noncritical: ${source}`);
  const validity = profileCandidateValidity(candidates, nodePath);
  const sites = [];
  for (let index = 0; index < candidates.length; index++) {
    const { mutant } = candidates[index], result = validity[index];
    if (!result.valid) { invalid.push({ id: mutant.id, reason: result.error }); continue; }
    sites.push({ id: mutant.id, source: mutant.source, line: mutant.line,
      operator: mutant.operator });
  }
  if (new Set(sites.map(site => site.id)).size !== sites.length)
    throw new Error('Node PR critical site IDs are duplicated');
  if (sites.length > cfg.mutation.maxMutants)
    throw new Error(`Node PR critical mutation budget incomplete: ${sites.length} valid sites exceed cap ${cfg.mutation.maxMutants}`);
  return { sites, filtered, invalid, maxMutants: cfg.mutation.maxMutants,
    maxSeconds: cfg.mutation.maxSeconds,
    scope: changed ? 'changed-critical-lines' : 'full-critical-sources' };
}
