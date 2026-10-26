import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../s12b/evidence.mjs';
import { FROZEN_PROFILE_RUNTIME_HASH } from '../s12b/evidence-node-context.mjs';
import { producerProof as s16ProducerProof } from '../s16/producer.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const hostDirs = ['plans/spikes/s12b/node-profile', 'packages/cupel/src/engine',
  'packages/cupel/src/analysis'];
const explicit = [
  ...['artifact', 'baseline', 'postprocess', 'producer', 'request',
    'test-universe', 'validation'].map(name =>
    `plans/spikes/s18/${name}.mjs`),
  ...['evidence', 'evidence-base', 'evidence-node-context', 'evidence-profile'].map(name =>
    `plans/spikes/s12b/${name}.mjs`),
  ...['capture', 'producer', 'selection', 'snapshot', 'validation'].map(name =>
    `plans/spikes/s16/${name}.mjs`),
  ...['input', 'config', 'report'].map(name => `spec/schemas/${name}.schema.json`),
];
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function sourceFiles() {
  const files = [...explicit];
  for (const dir of hostDirs) {
    const walk = sub => {
      for (const entry of readdirSync(join(repo, sub), { withFileTypes: true })) {
        const path = join(sub, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && /\.(?:mjs|cjs)$/.test(entry.name))
          files.push(relative(repo, join(repo, path)));
      }
    };
    walk(dir);
  }
  return [...new Set(files)].sort();
}

/** The new sealed producer is distinct from S16 and includes its live transitive proof. */
export function sealedProducerProof() {
  const s16 = s16ProducerProof(FROZEN_PROFILE_RUNTIME_HASH);
  const sourceManifest = sourceFiles().map(path => [path, sha(readFileSync(join(repo, path)))]);
  const producer = { version: 'cupel-s18-sealed-producer/1',
    referenceProfileHash: FROZEN_PROFILE_RUNTIME_HASH,
    s16ProducerHash: s16.producerHash,
    sourceHash: digest(sourceManifest) };
  return { producer, producerHash: digest(producer) };
}
