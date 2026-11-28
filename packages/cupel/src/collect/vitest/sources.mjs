import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globMatches } from '../../engine/match.mjs';
import { analyse, coveredLines } from '../node/lines.mjs';
import { isDeclarationFile } from '../../lang/js/declaration.mjs';
import { projectTypeScript, scanJsx } from '../../lang/js/project-typescript.mjs';
import { classifyTypeScript } from '../../lang/js/classify-typescript.mjs';
import { causeText, skipFile } from '../skipped.mjs';
import { inlineSourceMap, mappedLines } from './sourcemap.mjs';

export const posix = (p) => p.split(sep).join('/');
const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
export const TEST = /\.(?:test|spec)\.[cm]?(?:ts|js)x?$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__']);

export function walk(root, testFiles = false, log = () => {}, diagnostics = []) {
  const found = [];
  const visit = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (!rel) throw error;
      skipFile(diagnostics, log, 'Vitest directory', rel, error);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && (testFiles ? !['dist', 'build', 'coverage'].includes(entry.name) : !SKIP.has(entry.name))) visit(join(dir, entry.name), next);
      } else if (entry.isFile()) found.push(next);
    }
  };
  visit(root, '');
  return found.sort();
}

/**
 * Sources in scope: Map file -> { text, an, hash }. A file that cannot be read is named in `diagnostics` and, when
 * `unmeasured` is given, recorded there as file -> { hash?, reason } so the input lists it apart instead of dropping it.
 */
export function scanSources(root, scope, log = () => {}, diagnostics = [], unmeasured = null) {
  const files = walk(root, false, log, diagnostics).filter((file) => SOURCE.test(file) && !isDeclarationFile(file) && !TEST.test(file) &&
    (scope?.include ?? ['**']).some((g) => globMatches(g, file)) && !(scope?.exclude ?? []).some((g) => globMatches(g, file)));
  const sources = new Map();
  let ts;
  for (const file of files) {
    let hash;
    try {
      const buf = readFileSync(join(root, file));
      hash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
      if (/\.[jt]sx$/.test(file)) {
        ts ??= projectTypeScript(root);
        if (!ts) throw new Error('typescript is not resolvable from the project root');
      }
      const text = buf.toString('utf8');
      const an = /\.[jt]sx$/.test(file) ? scanJsx(ts, file, text).analysis :
        /\.[cm]?ts$/.test(file) ? classifyTypeScript(root, file, text).analysis : analyse(text, { strict: true });
      sources.set(file, { text, an, hash });
    } catch (error) {
      skipFile(diagnostics, log, 'Vitest', file, error);
      unmeasured?.set(file, { ...(hash ? { hash } : {}), reason: `not read by the Vitest runner: ${causeText(error)}` });
    }
  }
  return sources;
}

// A script object's decoded source map, kept while the caller keeps the object (one decode per script, not per call).
const decodedMaps = new WeakMap();
const mapOf = (script) => {
  let map = decodedMaps.get(script);
  if (!map) { map = inlineSourceMap(script.source); decodedMaps.set(script, map); }
  return map;
};

/** A null line set means a matching file could not be mapped and must be omitted. */
export function sourceMapLines(root, script, intervals, sources, log, diagnostics = []) {
  const url = script.url.replace(/[?#].*$/, '');
  let evaluatedPath;
  try { evaluatedPath = url.startsWith('file:') ? fileURLToPath(url) : url; } catch { return null; }
  const rel = posix(relative(root, evaluatedPath));
  const source = sources.get(rel);
  if (!source) return null;
  // Identical JavaScript has original offsets and does not require a source map.
  if (/\.[cm]?js$|\.jsx$/.test(rel) && !/\/[#@] sourceMappingURL=/.test(script.source) && script.source === source.text) {
    try { return [rel, coveredLines(source.an, intervals)]; }
    catch (error) { skipFile(diagnostics, log, 'mapping', rel, error); return [rel, null]; }
  }
  try {
    const map = mapOf(script);
    let index = -1;
    for (let i = 0; i < map.sources.length; i++) {
      const entry = map.sources[i];
      const path = entry.startsWith('file:') ? fileURLToPath(entry) : isAbsolute(entry) ? entry : resolve(dirname(evaluatedPath), map.sourceRoot ?? '', entry);
      if (posix(relative(root, path)) === rel) { index = i; break; }
    }
    if (index < 0) throw new Error('source map has no matching original source');
    if (map.sourcesContent?.[index] && map.sourcesContent[index] !== source.text) throw new Error('source map content differs from original');
    return [rel, mappedLines(script.source, intervals, map, index).filter((line) => source.an.hasCode[line - 1])];
  } catch (error) {
    skipFile(diagnostics, log, 'mapping', rel, error);
    return [rel, null];
  }
}
