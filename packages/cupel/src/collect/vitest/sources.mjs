import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globMatches } from '../../engine/match.mjs';
import { analyse, coveredLines } from '../node/lines.mjs';
import { VitestCollectorError } from './errors.mjs';
import { inlineSourceMap, mappedLines } from './sourcemap.mjs';

export const posix = (p) => p.split(sep).join('/');
const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
export const TEST = /\.(?:test|spec)\.[cm]?(?:ts|js)x?$/;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__']);

export function walk(root, testFiles = false) {
  const found = [];
  const visit = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

export function scanSources(root, scope) {
  const files = walk(root).filter((file) => SOURCE.test(file) && !TEST.test(file) &&
    (scope?.include ?? ['**']).some((g) => globMatches(g, file)) && !(scope?.exclude ?? []).some((g) => globMatches(g, file)));
  const sources = new Map();
  for (const file of files) {
    const buf = readFileSync(join(root, file));
    const text = buf.toString('utf8');
    let stripped = text;
    if (/\.[cm]?ts$|\.tsx$/.test(file)) {
      try { stripped = stripTypeScriptTypes(text); }
      catch (e) { throw new VitestCollectorError(`cannot strip TypeScript in ${file}: ${e.message}`); }
    }
    const an = analyse(stripped);
    if (an.lexer !== 'shared') throw new VitestCollectorError(`shared lexer cannot analyse ${file}; scanner fallback is not used`);
    sources.set(file, { text, an, hash: `sha256:${createHash('sha256').update(buf).digest('hex')}` });
  }
  return sources;
}

/** A null line set means a matching file could not be mapped and must be omitted. */
export function sourceMapLines(root, script, intervals, sources, log) {
  const url = script.url.replace(/[?#].*$/, '');
  let evaluatedPath;
  try { evaluatedPath = url.startsWith('file:') ? fileURLToPath(url) : url; } catch { return null; }
  const rel = posix(relative(root, evaluatedPath));
  const source = sources.get(rel);
  if (!source) return null;
  try {
    const map = inlineSourceMap(script.source);
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
    if (/\.[cm]?js$|\.jsx$/.test(rel) && script.source.replace(/\n?\/\/[#@] sourceMappingURL=.*$/s, '') === source.text) {
      return [rel, coveredLines(source.an, intervals)];
    }
    log(`mapping skipped for ${rel}: ${error.message}`);
    return [rel, null];
  }
}
