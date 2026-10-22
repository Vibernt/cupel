// Textual mutation over the shared lexer (spike S3, decision D6). Ported from plans/spikes/s3/mutate.mjs.
//
// Deterministic: the same source text and the same seed give the same mutants, in the same order, with the same ids.
// An id is `<source>:<line>:<col>:<operator>:<hash>`, where `hash` is a short hash of the replacement (the edits,
// relative to the mutated token), so it is stable for the same source text and site.
//
// Operators:
//   cmp-flip      === <-> !==, == <-> !=, < -> >=, >= -> <, > -> <=, <= -> >
//   boundary      < <-> <=, > <-> >=
//   bool-literal  true <-> false
//   logical       && <-> ||
//   negate-cond   if (c) / while (c)  ->  if (!(c))
//   remove-not    !x -> x
//   arith         + <-> -, * <-> /, % -> *, += <-> -=, ++ <-> --   (not a `+` next to a string or template literal)
//   return-value  return e -> return undefined   (return true <-> return false; bare return, null, undefined skipped)
//   remove-call   a statement that is only a call, `[await] f(...);`  ->  `;`
//
// Mutants inside a console.* call, or removing one, are marked `filtered: 'logging'` (meaningless by construction).
// Two edits that give the same text (either `!` of `!!x`) keep only the first.

import { createHash } from 'node:crypto';
import { tokenize, matchBrackets, regexAllowed } from '../lang/js/lexer.mjs';

export const OPERATORS = Object.freeze(['cmp-flip', 'boundary', 'bool-literal', 'logical', 'negate-cond', 'remove-not', 'arith', 'return-value', 'remove-call']);

const CMP_FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const BOUNDARY = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' };
const ARITH = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*', '+=': '-=', '-=': '+=', '++': '--', '--': '++' };
const RESERVED = new Set(['if', 'else', 'for', 'while', 'do', 'return', 'throw', 'const', 'let', 'var', 'function', 'class', 'new', 'delete', 'typeof', 'void', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'import', 'export', 'yield', 'in', 'of', 'instanceof', 'async']);

/** mulberry32: a small seeded PRNG, for deterministic sampling. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic subset of `cap` items (Fisher-Yates with the seed), returned in the input order. */
export function sample(list, cap, seed) {
  if (list.length <= cap) return [...list];
  const idx = list.map((_, k) => k);
  const rand = prng(seed);
  for (let k = idx.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [idx[k], idx[j]] = [idx[j], idx[k]];
  }
  return idx.slice(0, cap).sort((a, b) => a - b).map((k) => list[k]);
}

/** The source text with the mutant's edits applied. */
export function applyMutant(source, mutant) {
  const pieces = [];
  let at = 0;
  for (const edit of [...mutant.edits].sort((a, b) => a.start - b.start)) {
    pieces.push(source.slice(at, edit.start), edit.text);
    at = edit.end;
  }
  pieces.push(source.slice(at));
  return pieces.join('');
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

// Hash the resulting text without ever constructing a copy of the source for each site.
function mutantHash(source, edits) {
  const hash = createHash('sha256');
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    hash.update(source.slice(at, edit.start));
    hash.update(edit.text);
    at = edit.end;
  }
  hash.update(source.slice(at));
  return hash.digest('hex');
}

/** Ranges [start, end) of every `console.<name>(...)` call: mutants inside them only change log lines. */
function loggingRanges(tokens, pairs) {
  const ranges = [];
  for (let k = 0; k + 3 < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'name' && t.value === 'console' && tokens[k + 1].value === '.' && tokens[k + 2].type === 'name' && tokens[k + 3].value === '(' && tokens[k - 1]?.value !== '.') {
      const close = pairs.get(k + 3);
      if (close !== undefined) ranges.push([t.start, tokens[close].end]);
    }
  }
  return ranges;
}

/** Index of the token that ends the expression starting at `from`: a `;`, `,` or an unmatched `)`, `]`, `}`. */
function expressionEnd(tokens, pairs, from) {
  for (let k = from; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{') && pairs.has(k)) {
      k = pairs.get(k);
      continue;
    }
    if (t.type === 'template' && t.value.endsWith('${') && pairs.has(k)) {
      let j = pairs.get(k);
      while (tokens[j].value.endsWith('${') && pairs.has(j) && pairs.get(j) > j) j = pairs.get(j);
      k = j;
      continue;
    }
    if (t.type === 'punct' && (t.value === ';' || t.value === ')' || t.value === ']' || t.value === '}' || t.value === ',')) return k;
  }
  return tokens.length;
}

/** Whether token k can begin a statement: after `;`, `{`, `}`, `else`, `do`, a control header `)`, or at the start. */
function statementStart(tokens, pairs, k) {
  const p = tokens[k - 1];
  if (!p) return true;
  if (p.type === 'punct' && (p.value === ';' || p.value === '{' || p.value === '}')) return true;
  if (p.type === 'name' && (p.value === 'else' || p.value === 'do')) return true;
  if (p.type === 'punct' && p.value === ')') {
    const open = pairs.get(k - 1);
    const before = tokens[open - 1];
    return before?.type === 'name' && ['if', 'for', 'while'].includes(before.value);
  }
  return false;
}

/**
 * Every mutant of one source, in source order. Each is
 * { id, source, operator, line, col, start, original, replacement, edits, filtered }.
 * Throws the lexer's LexError when the source cannot be tokenised.
 */
export function generateMutants(source, text) {
  const tokens = tokenize(text);
  const pairs = matchBrackets(tokens);
  const logging = loggingRanges(tokens, pairs);
  const inLogging = (pos) => logging.some(([s, e]) => pos >= s && pos < e);
  const out = [];
  const seenText = new Set();
  const seenId = new Set();
  const add = (operator, tok, replacement, edits, extra = {}) => {
    const textHash = mutantHash(text, edits);
    if (seenText.has(textHash)) return false;
    const rel = edits.map((e) => [e.start - tok.start, e.end - e.start, e.text]);
    const id = `${source}:${tok.line}:${tok.col + 1}:${operator}:${sha(JSON.stringify(rel)).slice(0, 8)}`;
    if (seenId.has(id)) return false;
    seenText.add(textHash);
    seenId.add(id);
    out.push({
      id, source, operator, line: tok.line, col: tok.col + 1, start: tok.start,
      original: tok.value, replacement, edits,
      filtered: inLogging(tok.start) ? 'logging' : null,
      ...extra,
    });
    return true;
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k], prev = tokens[k - 1], next = tokens[k + 1];
    if (t.type === 'punct') {
      const v = t.value;
      if (CMP_FLIP[v]) add('cmp-flip', t, CMP_FLIP[v], [{ start: t.start, end: t.end, text: CMP_FLIP[v] }]);
      if (BOUNDARY[v]) add('boundary', t, BOUNDARY[v], [{ start: t.start, end: t.end, text: BOUNDARY[v] }]);
      if (v === '&&' || v === '||') {
        const r = v === '&&' ? '||' : '&&';
        add('logical', t, r, [{ start: t.start, end: t.end, text: r }]);
      }
      // `*` of `import * as`, `export *`, `function*`, `yield*` is syntax, not multiplication.
      const starSyntax = v === '*' && (regexAllowed(prev) || (prev?.type === 'name' && ['import', 'export', 'function', 'yield', 'async'].includes(prev.value)));
      if (ARITH[v] && !starSyntax) {
        const nearString = [prev, next].some((x) => x && (x.type === 'string' || x.type === 'template'));
        const plusEqString = v === '+=' && (next?.type === 'string' || next?.type === 'template');
        if (!(v === '+' && nearString) && !plusEqString) {
          const unary = (v === '+' || v === '-') && regexAllowed(prev);
          const r = ARITH[v];
          // A space keeps `a - -b` from becoming `a --b` and `+ +` from becoming `++`.
          const replacement = unary && (prev?.value === '+' || prev?.value === '-') ? ` ${r}` : r;
          add('arith', t, r, [{ start: t.start, end: t.end, text: replacement }], unary ? { unary: true } : {});
        }
      }
      if (v === '!') add('remove-not', t, '', [{ start: t.start, end: t.end, text: '' }]);
      continue;
    }
    if (t.type !== 'name' || prev?.value === '.' || prev?.value === '?.') continue;
    if (t.value === 'true' || t.value === 'false') {
      const isKey = next?.value === ':' && (prev?.value === '{' || prev?.value === ',');
      if (!isKey) {
        const r = t.value === 'true' ? 'false' : 'true';
        add('bool-literal', t, r, [{ start: t.start, end: t.end, text: r }]);
      }
    } else if ((t.value === 'if' || t.value === 'while') && next?.value === '(' && pairs.has(k + 1)) {
      const close = pairs.get(k + 1);
      add('negate-cond', t, `${t.value} (!(…))`, [{ start: next.end, end: next.end, text: '!(' }, { start: tokens[close].start, end: tokens[close].start, text: ')' }]);
    } else if (t.value === 'return') {
      if (!next || next.value === ';' || next.value === '}' || next.line !== t.line) continue;
      const end = expressionEnd(tokens, pairs, k + 1);
      if (end <= k + 1) continue;
      const single = end === k + 2 ? next.value : null;
      if (single === 'null' || single === 'undefined') continue;
      const r = single === 'true' ? 'false' : single === 'false' ? 'true' : 'undefined';
      add('return-value', t, `return ${r}`, [{ start: next.start, end: tokens[end - 1].end, text: r }]);
    } else if (!RESERVED.has(t.value) && statementStart(tokens, pairs, k)) {
      // `[await] callee(...)...(...);` and nothing else in the statement.
      let j = k;
      if (t.value === 'await') j++;
      if (tokens[j]?.type !== 'name' || RESERVED.has(tokens[j].value)) continue;
      let sawCall = false, ok = true, last = j;
      j++;
      while (j < tokens.length) {
        const u = tokens[j];
        if (u.value === ';' || u.value === '}') break;
        if ((u.value === '.' || u.value === '?.') && tokens[j + 1]?.type === 'name') {
          last = j + 1;
          j += 2;
          continue;
        }
        if ((u.value === '(' || u.value === '[') && pairs.has(j)) {
          sawCall = sawCall || u.value === '(';
          last = pairs.get(j);
          j = last + 1;
          continue;
        }
        ok = false;
        break;
      }
      const endTok = tokens[j];
      if (!ok || !sawCall || tokens[last].value !== ')' || !endTok || endTok.value !== ';') continue;
      const c0 = t.value === 'await' ? k + 1 : k;
      let p = c0;
      while (tokens[p].value !== '(' && tokens[p].value !== '[') p++;
      const callee = text.slice(tokens[c0].start, tokens[p].start).replace(/\s+/g, '').slice(0, 40);
      const isLog = tokens[c0].value === 'console';
      if (add('remove-call', t, `remove ${callee}…`, [{ start: t.start, end: endTok.end, text: ';' }]) && isLog) {
        out[out.length - 1].filtered = 'logging';
      }
    }
  }
  return out;
}
