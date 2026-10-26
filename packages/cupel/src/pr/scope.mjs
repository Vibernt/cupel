import { readFileSync } from 'node:fs';
import { effectiveConfig } from '../engine/config.mjs';
import { isCriticalSource } from '../engine/model.mjs';
import { changedCriticalSourceLineSides } from './changed-lines.mjs';
import { criticalProfileSites } from './profiles/node/critical-sites.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url)));

/** Derive exact HEAD critical line scope from pinned base bytes and fresh HEAD. */
export function nodeProfileMutationScope({ root, baseline, head, decision, nodePath,
  headManifest }) {
  const cfg = effectiveConfig(baseline.config, schema);
  const changed = {};
  const lineSides = {};
  for (const source of decision.changedSources) {
    if (!isCriticalSource(source, cfg)) continue;
    const sides = changedCriticalSourceLineSides({ root,
      baseCommit: baseline.baseCommit, source,
      baseHash: baseline.git.inputManifest[source],
      headHash: headManifest[source] });
    changed[source] = sides.head;
    lineSides[source] = sides;
  }
  if (decision.route === 'profile-full' || decision.changedCriticalTests.length)
    return { ...criticalProfileSites({ root, input: head.input, manifest: headManifest,
      config: baseline.config, nodePath }), lineSides };
  const critical = criticalProfileSites({ root, input: head.input,
    manifest: headManifest, config: baseline.config, nodePath, changed });
  return { ...critical, lineSides };
}
