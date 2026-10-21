// Tokens, words and globs (SPEC section 5). Pure.

const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

/**
 * Splits a path or title into lowercased tokens: at every character that is not a letter or
 * digit, and at every lowercase-to-uppercase boundary.
 */
export function tokens(text) {
  const out = [];
  let cur = '';
  let prevLower = false;
  for (const ch of text) {
    if (!LETTER_OR_DIGIT.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      prevLower = false;
      continue;
    }
    if (prevLower && UPPER.test(ch)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
    prevLower = LOWER.test(ch);
  }
  if (cur) out.push(cur);
  return out.map((t) => t.toLowerCase());
}

/**
 * True when the word's tokens appear consecutively in `textTokens`: each equal, except the last,
 * which only needs to be a prefix. A word with no tokens (such as "-") matches vacuously.
 */
export function wordMatches(word, textTokens) {
  const w = tokens(word);
  if (w.length === 0) return true;
  const last = w.length - 1;
  for (let i = 0; i + w.length <= textTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < last && ok; j++) ok = textTokens[i + j] === w[j];
    if (ok && textTokens[i + last].startsWith(w[last])) return true;
  }
  return false;
}

export const anyWordMatches = (words, text) => {
  const t = tokens(text);
  return words.some((w) => wordMatches(w, t));
};

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const cache = new Map();

/**
 * Compiles a glob to an anchored regular expression.
 * - A segment that is exactly `**` matches zero or more whole path segments.
 * - `*` matches any run of characters except `/`; `?` one character except `/`.
 * - `**` inside a segment (such as `a**b`) is not a whole segment: with `loose` it matches any
 *   run including `/`, otherwise it behaves as `*`. Critical globs are loose and minor globs
 *   strict, so the ambiguous form always errs towards protecting tests (ENGINE-NOTES).
 */
export function globToRegExp(glob, loose) {
  const key = `${loose ? 1 : 0}\u0000${glob}`;
  if (cache.has(key)) return cache.get(key);
  const isGlobstar = (s) => /^\*\*+$/.test(s);
  // Consecutive `**` segments match the same as one.
  const segs = glob.split('/').filter((s, i, all) => !(isGlobstar(s) && i > 0 && isGlobstar(all[i - 1])));
  let re = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const first = i === 0;
    const last = i === segs.length - 1;
    if (isGlobstar(seg)) {
      if (segs.length === 1) re += '.*';
      else if (first) re += '(?:[^/]*/)*';
      else if (last) re += '(?:/[^/]*)*';
      else re += '/(?:[^/]*/)*';
      continue;
    }
    // A `**` segment before this one already supplied the separating slash.
    if (!first && !isGlobstar(segs[i - 1])) re += '/';
    re += segmentToRegExp(seg, loose);
  }
  const compiled = new RegExp(`^${re}$`, 'su');
  cache.set(key, compiled);
  return compiled;
}

function segmentToRegExp(seg, loose) {
  let out = '';
  for (let i = 0; i < seg.length; ) {
    if (seg[i] === '*') {
      let j = i;
      while (seg[j] === '*') j++;
      out += j - i >= 2 && loose ? '.*' : '[^/]*';
      i = j;
    } else if (seg[i] === '?') {
      out += '[^/]';
      i++;
    } else {
      const cp = seg.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      out += ch.replace(ESCAPE, '\\$&');
      i += ch.length;
    }
  }
  return out;
}

export const globMatches = (glob, path, loose = false) => globToRegExp(glob, loose).test(path);

export const anyGlobMatches = (globs, path, loose = false) => globs.some((g) => globMatches(g, path, loose));
