// The line rule (K1): which lines of a source are coverable, and which lines a set of covered character
// intervals covers.
//
//  - Each UTF-16 code unit is whitespace, comment or code. Comments come from the shared lexer
//    (src/lang/js/lexer.mjs, D6); every other non-whitespace character, strings, templates and regular
//    expressions included, is code.
//  - A line is coverable when it holds a code character, and covered when one of its code characters lies in
//    a positive interval (see intervals.mjs for the innermost-range rule).
//  - Lines are split at "\n" only, so line numbers agree with git diff.
//
// A source the lexer cannot read (not JavaScript, or a construct it does not know) falls back to the scanner
// of spike S2 (plans/spikes/s2/lines.mjs), which never throws. `analyse` reports which one it used.

import { tokenize } from '../../lang/js/lexer.mjs';

const isWsCode = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff ||
  c === 0x2028 || c === 0x2029 || (c > 127 && /\s/u.test(String.fromCharCode(c)));

/** 1 for each code character, from the shared lexer. Throws LexError when the lexer cannot read the source. */
export function lexerMask(src) {
  const mask = new Uint8Array(src.length);
  for (const t of tokenize(src, { comments: true })) {
    if (t.type === 'comment') continue;
    for (let i = t.start; i < t.end; i++) if (!isWsCode(src.charCodeAt(i))) mask[i] = 1;
  }
  // A hashbang line is a comment (ECMAScript's HashbangComment); the lexer skips it.
  return mask;
}

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await', 'extends']);
const isIdent = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127;

/** Spike S2's heuristic scanner: the fallback for sources the lexer rejects. Never throws. */
export function fallbackMask(src) {
  const n = src.length;
  const mask = new Uint8Array(n);
  const templateDepths = [];
  let depth = 0;
  let prev = '';
  let i = 0;
  if (src.startsWith('#!')) { while (i < n && src.charCodeAt(i) !== 10) i++; }
  const scanTemplate = () => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 92) { mask[i] = 1; if (i + 1 < n && !isWsCode(src.charCodeAt(i + 1))) mask[i + 1] = 1; i += 2; continue; }
      if (c === 96) { mask[i] = 1; i++; prev = 'str'; return; }
      if (c === 36 && src.charCodeAt(i + 1) === 123) { mask[i] = 1; mask[i + 1] = 1; i += 2; templateDepths.push(depth); depth++; prev = '('; return; }
      if (!isWsCode(c)) mask[i] = 1;
      i++;
    }
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isWsCode(c)) { i++; continue; }
    const d = src.charCodeAt(i + 1);
    if (c === 47 && d === 47) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; }
    if (c === 47 && d === 42) { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === 39 || c === 34) {
      mask[i] = 1; i++;
      while (i < n) {
        const e = src.charCodeAt(i);
        if (e === 92) { mask[i] = 1; if (i + 1 < n && !isWsCode(src.charCodeAt(i + 1))) mask[i + 1] = 1; i += 2; continue; }
        if (!isWsCode(e)) mask[i] = 1;
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
          if (!isWsCode(e)) mask[i] = 1;
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
      prev = c >= 48 && c <= 57 ? 'num' : `word:${src.slice(start, i)}`;
      continue;
    }
    mask[i] = 1;
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) { templateDepths.pop(); i++; scanTemplate(); continue; }
    }
    prev = String.fromCharCode(c);
    i++;
  }
  return mask;
}

/**
 * Per-source facts for the line rule. A leading byte order mark is dropped first: Node strips it before V8
 * sees the source, so V8 offsets count from the character after it.
 * Returns { lexer: 'shared' | 'fallback', n, mask, lineStarts, lineEnds, hasCode, coverable: number[] }.
 * It keeps one byte per character, so a whole repository's sources stay small.
 */
export function analyse(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let mask;
  let lexer = 'shared';
  try { mask = lexerMask(src); } catch { mask = fallbackMask(src); lexer = 'fallback'; }
  return analyseMask(src, mask, lexer);
}

/** Build line facts from a scanner's exact UTF-16 code-character mask. */
export function analyseMask(src, mask, lexer) {
  const n = src.length;
  const starts = [0];
  for (let i = 0; i < n; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  const lineStarts = Uint32Array.from(starts);
  const lines = lineStarts.length;
  const lineEnds = new Uint32Array(lines);
  const hasCode = new Uint8Array(lines);
  const coverable = [];
  for (let l = 0; l < lines; l++) {
    const a = lineStarts[l];
    const b = l + 1 < lines ? lineStarts[l + 1] : n;
    lineEnds[l] = b;
    for (let i = a; i < b; i++) if (mask[i]) { hasCode[l] = 1; coverable.push(l + 1); break; }
  }
  return { lexer, n, mask, lineStarts, lineEnds, hasCode, coverable };
}

function lineIndex(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The covered lines (ascending numbers) for flat positive intervals [s0, e0, s1, e1, ...] over one source. */
export function coveredLines(an, intervals) {
  const out = [];
  let lastLine = 0;
  for (let k = 0; k < intervals.length; k += 2) {
    const a = Math.max(0, intervals[k]);
    const b = Math.min(an.n, intervals[k + 1]);
    if (b <= a) continue;
    const first = lineIndex(an.lineStarts, a);
    const last = lineIndex(an.lineStarts, b - 1);
    for (let l = Math.max(first, lastLine); l <= last; l++) {
      if (!an.hasCode[l]) continue;
      const ls = an.lineStarts[l], le = an.lineEnds[l];
      let hit = a <= ls && b >= le; // the whole line lies inside the interval
      if (!hit) for (let i = Math.max(a, ls), e = Math.min(b, le); i < e; i++) if (an.mask[i]) { hit = true; break; }
      if (hit) { out.push(l + 1); lastLine = l + 1; }
    }
  }
  return out;
}

/** The canonical line-set string (SPEC 3.1) for ascending, distinct line numbers. */
export function formatLines(sorted) {
  let out = '';
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out += `${out ? ',' : ''}${sorted[i]}${j > i ? `-${sorted[j]}` : ''}`;
    i = j + 1;
  }
  return out;
}

/** Ascending distinct union of two ascending distinct number arrays. */
export function unionLines(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) out.push(a[i++]);
    else if (a[i] > b[j]) out.push(b[j++]);
    else { out.push(a[i]); i++; j++; }
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
