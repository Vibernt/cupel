import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmp } from '../engine/order.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Hash the entire installed source/schema closure, with no caller-selected omissions. */
export function packageSourceManifest(root = packageRoot) {
  const manifest = [];
  const walk = relative => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const file = `${relative}/${name}`;
      const stat = lstatSync(join(root, file));
      if (stat.isSymbolicLink()) throw new Error(`Node PR producer refuses symlink: ${file}`);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && /\.(?:[cm]?js|json)$/.test(name))
        manifest.push([file, sha(readFileSync(join(root, file)))]);
      else if (!stat.isFile()) throw new Error(`Node PR producer refuses non-file: ${file}`);
    }
  };
  for (const dir of ['src', 'schemas']) walk(dir);
  manifest.push(['package.json', sha(readFileSync(join(root, 'package.json')))]);
  return manifest.sort((a, b) => cmp(a[0], b[0]));
}

export function nodeProfileProducerProof() {
  const sources = packageSourceManifest();
  const producer = { version: 'cupel-pr-node-producer/1', profile: 'node-readonly-files-v2',
    scope: 'installed-package-source-and-schemas', sourceHash: sha(JSON.stringify(sources)) };
  return { producer, producerHash: sha(JSON.stringify(producer)), sourceCount: sources.length };
}
