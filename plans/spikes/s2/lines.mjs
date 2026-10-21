// S2 line rule: turns V8 coverage (ranges) into sets of covered source lines.
//
// Usage (as a library):
//   import { LineRule } from './lines.mjs';
//   const rule = new LineRule('/path/to/suite/root', ['src/', 'public/']);
//   const sets = rule.lineSets(scriptCoverages);   // Map<'src/x.mjs', Set<lineNumber>>
//   rule.codeLines('src/x.mjs')                     // Set of lines that hold code (the denominator)
//
// Usage (CLI, to inspect one NODE_V8_COVERAGE file):
//   node lines.mjs <suite-root> <coverage-*.json>
//
// The rule, applied the same way to both collection methods:
//  1. V8 ranges are nested. The count of a character is the count of the innermost range that contains it.
//     A character outside every reported range has count 0 (takePreciseCoverage after a reset only reports
//     the functions that ran since the last call).
//  2. A line is covered when at least one code character on it has a count > 0. Code characters are
//     the characters that are not whitespace and not inside a comment (strings, templates and regular
//     expression literals are code).
//  3. Lines with no code characters (blank and comment-only lines) are never counted.
//  4. Only sources under the given prefixes (src/** and public/**) relative to the suite root are counted.
//     Query strings and hashes on module URLs are dropped, so `x.mjs?v=2` counts as `x.mjs`.
//
// Standard library only.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, sep } from 'node:path';

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
  'yield', 'await', 'extends',
]);
const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff ||
  c === 0x2028 || c === 0x2029;
const isIdent = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127;

/**
 * Marks the code characters of a JavaScript source: 1 for a character that is not whitespace and not in a
 * comment. A small scanner, not a parser: it tracks strings, template literals (with nested `${}`),
 * regular expression literals (decided by the previous token) and comments. Good enough to tell comment
 * lines from code lines; it does not need to be exact anywhere else.
 */
export function codeMask(src) {
  const n = src.length;
  const mask = new Uint8Array(n);
  const templateDepths = []; // brace depth at which each open `${` returns to its template
  let depth = 0;
  let prev = ''; // previous significant token: 'word:<w>', 'num', ')', ']', '}', or an operator char
  let i = 0;
  if (src.startsWith('#!')) { while (i < n && src.charCodeAt(i) !== 10) i++; }
  const scanTemplate = () => {
    // i is just after a backtick or a closing `}` of `${`; scan to the end of the template chunk.
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 92) { mask[i] = 1; if (i + 1 < n && !isWs(src.charCodeAt(i + 1))) mask[i + 1] = 1; i += 2; continue; }
      if (c === 96) { mask[i] = 1; i++; prev = 'str'; return; }
      if (c === 36 && src.charCodeAt(i + 1) === 123) { mask[i] = 1; mask[i + 1] = 1; i += 2; templateDepths.push(depth); depth++; prev = '('; return; }
      if (!isWs(c)) mask[i] = 1;
      i++;
    }
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isWs(c)) { i++; continue; }
    const d = src.charCodeAt(i + 1);
    if (c === 47 && d === 47) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; }
    if (c === 47 && d === 42) { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === 39 || c === 34) {
      mask[i] = 1; i++;
      while (i < n) {
        const e = src.charCodeAt(i);
        if (e === 92) { mask[i] = 1; if (i + 1 < n && !isWs(src.charCodeAt(i + 1))) mask[i + 1] = 1; i += 2; continue; }
        if (!isWs(e)) mask[i] = 1;
        i++;
        if (e === c || e === 10) break;
      }
      prev = 'str'; continue;
    }
    if (c === 96) { mask[i] = 1; i++; scanTemplate(); continue; }
    if (c === 47) {
      const regexAllowed = prev === '' || prev === '}' || (prev.startsWith('word:') && KEYWORDS_BEFORE_REGEX.has(prev.slice(5))) ||
        !(prev === 'num' || prev === 'str' || prev === ')' || prev === ']' || prev.startsWith('word:'));
      if (regexAllowed) {
        mask[i] = 1; i++;
        let inClass = false;
        while (i < n) {
          const e = src.charCodeAt(i);
          if (e === 10) break;
          if (!isWs(e)) mask[i] = 1;
          if (e === 92) { if (i + 1 < n) mask[i + 1] = 1; i += 2; continue; }
          i++;
          if (e === 91) inClass = true;
          else if (e === 93) inClass = false;
          else if (e === 47 && !inClass) break;
        }
        while (i < n && isIdent(src.charCodeAt(i))) { mask[i] = 1; i++; }
        prev = 'str'; continue;
      }
      mask[i] = 1; i++; prev = '/'; continue;
    }
    if (isIdent(c)) {
      const start = i;
      while (i < n && isIdent(src.charCodeAt(i))) { mask[i] = 1; i++; }
      const word = src.slice(start, i);
      prev = c >= 48 && c <= 57 ? 'num' : `word:${word}`;
      continue;
    }
    mask[i] = 1;
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop(); i++; scanTemplate(); continue;
      }
    }
    prev = String.fromCharCode(c);
    i++;
  }
  return mask;
}

/** Per-source facts the rule needs: line starts, and a prefix count of code characters. */
export function analyseSource(src) {
  const mask = codeMask(src);
  const n = src.length;
  const lineStarts = [0];
  for (let i = 0; i < n; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const prefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + mask[i];
  const codeLines = new Set();
  for (let l = 0; l < lineStarts.length; l++) {
    const a = lineStarts[l];
    const b = l + 1 < lineStarts.length ? lineStarts[l + 1] : n;
    if (prefix[b] - prefix[a] > 0) codeLines.add(l + 1);
  }
  return { n, lineStarts, prefix, codeLines };
}

function lineOf(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo; // zero-based
}

/**
 * Flattens nested ranges into disjoint [start, end, count] segments where the count is the innermost
 * range's count. Ranges arrive as V8 gives them (functions[].ranges[]); later ranges with the same extent win.
 */
export function flatten(functions) {
  const ranges = [];
  let order = 0;
  for (const fn of functions) for (const r of fn.ranges) ranges.push({ s: r.startOffset, e: r.endOffset, c: r.count, o: order++ });
  ranges.sort((x, y) => x.s - y.s || y.e - x.e || x.o - y.o);
  const out = [];
  const stack = [];
  let pos = 0;
  const emit = (a, b, c) => { if (b > a) out.push([a, b, c]); };
  for (const r of ranges) {
    while (stack.length && stack[stack.length - 1].e <= r.s) {
      const top = stack.pop();
      emit(pos, top.e, top.c);
      pos = Math.max(pos, top.e);
    }
    if (stack.length) emit(pos, r.s, stack[stack.length - 1].c);
    pos = Math.max(pos, r.s);
    stack.push(r);
  }
  while (stack.length) {
    const top = stack.pop();
    emit(pos, top.e, top.c);
    pos = Math.max(pos, top.e);
  }
  return out;
}

export class LineRule {
  constructor(root, prefixes = ['src/', 'public/']) {
    this.root = root;
    this.prefixes = prefixes;
    this.sources = new Map();
  }

  /** The suite-relative path for a script URL, or null when it is outside the counted prefixes. */
  pathOf(url) {
    if (!url || !url.startsWith('file:')) return null;
    let path;
    try { path = fileURLToPath(url.replace(/[?#].*$/, '')); } catch { return null; }
    const rel = relative(this.root, path).split(sep).join('/');
    return this.prefixes.some((p) => rel.startsWith(p)) ? rel : null;
  }

  source(rel) {
    let s = this.sources.get(rel);
    if (!s) {
      let text = '';
      try { text = readFileSync(`${this.root}/${rel}`, 'utf8'); } catch { /* deleted or generated: no lines */ }
      s = analyseSource(text);
      this.sources.set(rel, s);
    }
    return s;
  }

  codeLines(rel) { return this.source(rel).codeLines; }

  /** Covered lines of one script's functions (the rule above). */
  coveredLines(rel, functions) {
    const src = this.source(rel);
    const lines = new Set();
    for (const [a, b0, c] of flatten(functions)) {
      if (c <= 0) continue;
      const b = Math.min(b0, src.n);
      if (b <= a || src.prefix[b] - src.prefix[a] === 0) continue;
      const first = lineOf(src.lineStarts, a);
      const last = lineOf(src.lineStarts, b - 1);
      for (let l = first; l <= last; l++) {
        const ls = Math.max(a, src.lineStarts[l]);
        const le = Math.min(b, l + 1 < src.lineStarts.length ? src.lineStarts[l + 1] : src.n);
        if (src.prefix[le] - src.prefix[ls] > 0) lines.add(l + 1);
      }
    }
    return lines;
  }

  /** Map<rel path, Set<line>> for a list of ScriptCoverage objects ({ url, functions }). */
  lineSets(scripts, into = new Map()) {
    for (const sc of scripts) {
      const rel = this.pathOf(sc.url);
      if (!rel) continue;
      const lines = this.coveredLines(rel, sc.functions);
      if (!lines.size) continue;
      let set = into.get(rel);
      if (!set) into.set(rel, (set = new Set()));
      for (const l of lines) set.add(l);
    }
    return into;
  }
}

/** Flattens Map<path, Set<line>> into a Set of 'path:line' keys. */
export function keys(map) {
  const out = new Set();
  for (const [p, ls] of map) for (const l of ls) out.add(`${p}:${l}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, file] = process.argv.slice(2);
  if (!root || !file) { console.error('usage: node lines.mjs <suite-root> <coverage.json>'); process.exit(2); }
  const rule = new LineRule(root);
  const sets = rule.lineSets(JSON.parse(readFileSync(file, 'utf8')).result);
  let covered = 0, code = 0;
  for (const [p, ls] of [...sets].sort()) { covered += ls.size; code += rule.codeLines(p).size; console.log(`${p}\t${ls.size}/${rule.codeLines(p).size}`); }
  console.log(`total\t${covered}/${code} code lines in touched files`);
}
