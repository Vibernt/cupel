import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyMutant } from '../../../mutate/operators.mjs';
import { sourceMutants } from '../../../mutate/sites.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const PIN = /^sha256:[0-9a-f]{64}$/;

/** Build a mutation pipe payload from current, pinned source bytes and a regenerated site. */
export function mutationPipeSpec({ root, source, sourceHash, mutantId }) {
  if (typeof source !== 'string' || !/^[^./][^\\]*\.(?:[cm]?js|ts|mts|cts)$/.test(source) ||
      source.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !PIN.test(sourceHash) || typeof mutantId !== 'string' || !mutantId) {
    throw new Error('invalid pinned Node mutation source or mutant identity');
  }
  const base = realpathSync(resolve(root));
  const path = resolve(base, source);
  if (!path.startsWith(`${base}${sep}`)) throw new Error('Node mutation source escapes root');
  let current = base;
  for (const part of source.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Node mutation source is symlinked: ${source}`);
  }
  if (!lstatSync(path).isFile()) throw new Error(`Node mutation source is not regular: ${source}`);
  const raw = readFileSync(path);
  if (hash(raw) !== sourceHash) throw new Error(`Node mutation source changed: ${source}`);
  const text = raw.toString('utf8');
  const candidates = sourceMutants(base, source, text);
  if (!candidates) throw new Error(`Node mutation source cannot be parsed: ${source}`);
  const mutant = candidates.find(item => item.id === mutantId && !item.filtered);
  if (!mutant) throw new Error(`Node mutation site is absent or filtered: ${mutantId}`);
  const replacementText = applyMutant(text, mutant);
  if (replacementText === text || Buffer.byteLength(replacementText) > (32 << 20))
    throw new Error('Node mutation replacement is empty or exceeds 32 MiB');
  return Object.freeze({ version: 'cupel-node-mutation-pipe/1', source,
    url: pathToFileURL(path).href, originalHash: sourceHash,
    mutant: { id: mutant.id, source: mutant.source, line: mutant.line,
      operator: mutant.operator, edits: mutant.edits },
    replacementHash: hash(replacementText), replacementText });
}
