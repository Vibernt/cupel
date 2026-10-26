import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./validity-worker.mjs', import.meta.url));
const modes = new Set(['commonjs', 'module']);

/** Parse every candidate with one fixed Node 26 worker and no alternate parser path. */
export function profileCandidateValidity(items, nodePath) {
  if (!Array.isArray(items) || !items.length) return [];
  const payload = items.map(({ mutant, text, jsMode }) => {
    if (!mutant || typeof text !== 'string') throw new Error('Node PR validity candidate malformed');
    const ext = extname(mutant.source);
    if (['.jsx', '.tsx'].includes(ext) || mutant.mode === 'typescript-scanned')
      throw new Error(`Node PR native profile cannot parse JSX source: ${mutant.source}`);
    const mode = ['.cts', '.cjs'].includes(ext) ? 'commonjs' :
      ['.mts', '.ts', '.mjs'].includes(ext) ? 'module' : jsMode;
    if (!modes.has(mode)) throw new Error(`Node PR source mode unsupported: ${mutant.source}`);
    return { mode, text: ['.ts', '.mts', '.cts'].includes(ext) ? stripTypeScriptTypes(text) : text };
  });
  const result = spawnSync(nodePath, ['--permission', `--allow-fs-read=${worker}`,
    '--experimental-vm-modules', '--no-warnings', '--disable-sigusr1', worker],
  { input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
    maxBuffer: 8 << 20, env: { CI: '1', NO_COLOR: '1', LANG: 'C', TZ: 'UTC' } });
  if (result.error || result.status !== 0)
    throw new Error(`Node PR fixed validity worker failed: ${result.error?.message ??
      result.stderr?.split('\n')[0] ?? result.status}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { throw new Error(`Node PR fixed validity worker output malformed: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length !== items.length ||
      parsed.some(row => !row || typeof row.valid !== 'boolean' ||
        (row.valid ? Object.keys(row).length !== 1 : typeof row.error !== 'string')))
    throw new Error('Node PR fixed validity worker result count or shape invalid');
  return parsed;
}
