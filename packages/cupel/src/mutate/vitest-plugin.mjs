import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function createMutantPlugin() {
  return { name: 'cupel-mutant', enforce: 'pre', load(id) {
    const path = process.env.CUPEL_MUTANT;
    if (!path) return null;
    const spec = JSON.parse(readFileSync(path, 'utf8'));
    let target = id.split('?')[0].split('#')[0];
    if (target.startsWith('file:')) target = fileURLToPath(target);
    try { if (realpathSync(target) !== spec.realPath) return null; } catch { return null; }
    appendFileSync(spec.seen, 'loaded\n');
    return readFileSync(spec.sourcePath, 'utf8');
  } };
}
