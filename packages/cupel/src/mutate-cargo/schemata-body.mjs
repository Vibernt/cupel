// Exact Rust mutant schemata for operators whose replacement changes parsing.
// Each fault gets a complete, independently parsed copy of its function body.
// Pure: no I/O, no node: imports.

import { lexRust } from './schemata.mjs';

const PATH_RE = /^(::)?[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;
const PAIR = { '(': ')', '[': ']', '{': '}' };
const NESTED_ITEMS = new Set(['fn', 'struct', 'enum', 'impl', 'trait', 'mod', 'static', 'const', 'use', 'macro_rules', 'type']);
const POSITION_MACROS = new Set(['line', 'column', 'file']);
const DEFAULT_BUDGET = 16 * 1024;
const MAX_FAULTS = 8;

function lineStarts(text) {
  const starts = [0];
  for (let at = 0; at < text.length; at++) if (text[at] === '\n') starts.push(at + 1);
  return starts;
}

function offsetOf(text, starts, pos) {
  if (!pos || !Number.isInteger(pos.line) || !Number.isInteger(pos.column) || pos.line < 1 || pos.column < 1) return -1;
  if (pos.line > starts.length) return -1;
  let at = starts[pos.line - 1];
  const end = pos.line < starts.length ? starts[pos.line] - 1 : text.length;
  for (let column = 1; column < pos.column; column++) {
    if (at >= end) return -1;
    at += text.codePointAt(at) > 0xffff ? 2 : 1;
  }
  return at;
}

function matchDelimiters(tokens) {
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.k === 'o') stack.push(index);
    if (token.k === 'c') {
      const open = stack.pop();
      if (open === undefined || PAIR[tokens[open].v] !== token.v) return false;
      tokens[open].m = index;
      token.m = open;
    }
  }
  return stack.length === 0;
}

function adjacentPunct(tokens, index, value) {
  for (let part = 0; part < value.length; part++) {
    const token = tokens[index + part];
    if (!token || token.k !== 'p' || token.v !== value[part]) return false;
    if (part < value.length - 1 && token.e !== tokens[index + part + 1]?.s) return false;
  }
  return true;
}

function angleEnd(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.k === 'o') { index = token.m; continue; }
    if (token.k !== 'p') continue;
    if (token.v === '<') depth++;
    if (token.v === '>') {
      depth--;
      if (depth === 0) return index + 1;
    }
    if (token.v === ';' && depth === 0) return -1;
  }
  return -1;
}

function modifierStart(tokens, fnIndex) {
  let start = fnIndex;
  for (let index = fnIndex - 1; index >= 0; index--) {
    const token = tokens[index];
    if ((token.k === 'p' && token.v === ';') || (token.k === 'o' && token.v === '{') || (token.k === 'c' && token.v === '}')) break;
    start = index;
  }
  return start;
}

function functionsIn(tokens) {
  const functions = [];
  for (let fnIndex = 0; fnIndex < tokens.length; fnIndex++) {
    const token = tokens[fnIndex];
    if (token.k !== 'id' || token.raw || token.v !== 'fn' || tokens[fnIndex + 1]?.k !== 'id') continue;
    let index = fnIndex + 2;
    let generic = false;
    if (tokens[index]?.k === 'p' && tokens[index].v === '<') {
      generic = true;
      index = angleEnd(tokens, index);
      if (index < 0) continue;
    }
    if (tokens[index]?.k !== 'o' || tokens[index].v !== '(') continue;
    const paramsEnd = tokens[index].m;
    if (!Number.isInteger(paramsEnd)) continue;
    index = paramsEnd + 1;
    let angleDepth = 0;
    let body = -1;
    while (index < tokens.length) {
      const current = tokens[index];
      if (current.k === 'p' && current.v === ';' && angleDepth === 0) break;
      if (current.k === 'p' && current.v === '<') angleDepth++;
      else if (current.k === 'p' && current.v === '>' && angleDepth > 0) angleDepth--;
      if (current.k === 'o') {
        if (current.v === '{' && angleDepth === 0) { body = index; break; }
        index = current.m + 1;
        continue;
      }
      index++;
    }
    if (body < 0 || !Number.isInteger(tokens[body].m)) continue;
    const prefix = tokens.slice(modifierStart(tokens, fnIndex), fnIndex);
    const afterParams = tokens.slice(paramsEnd + 1, body);
    const arrow = afterParams.findIndex((part, at) => part.k === 'p' && part.v === '-' && part.e === afterParams[at + 1]?.s && afterParams[at + 1]?.v === '>');
    const returns = arrow < 0 ? [] : afterParams.slice(arrow + 2);
    functions.push({
      fn: fnIndex,
      body,
      close: tokens[body].m,
      generic,
      isConst: prefix.some((part) => part.k === 'id' && !part.raw && part.v === 'const'),
      isAsync: prefix.some((part) => part.k === 'id' && !part.raw && part.v === 'async'),
      badReturn: returns.some((part) => (part.k === 'id' && !part.raw && part.v === 'impl') || (part.k === 'p' && part.v === '!')),
    });
  }
  return functions;
}

function isInnerAttribute(tokens, index) {
  return tokens[index]?.k === 'p' && tokens[index].v === '#'
    && tokens[index + 1]?.k === 'p' && tokens[index + 1].v === '!'
    && tokens[index + 2]?.k === 'o' && tokens[index + 2].v === '[';
}

function isNestedItem(tokens, index) {
  const token = tokens[index];
  if (token?.k !== 'id' || token.raw || !NESTED_ITEMS.has(token.v)) return false;
  if (token.v === 'const') {
    const next = tokens[index + 1];
    if (next?.k !== 'id') return false; // `const { ... }` is an expression.
    const previous = tokens[index - 1];
    return previous === undefined || (previous.k === 'p' && previous.v === ';')
      || (previous.k === 'o' && previous.v === '{') || (previous.k === 'c' && previous.v === '}');
  }
  if (token.v === 'fn') return tokens[index + 1]?.k === 'id';
  return true;
}

function macroReason(text, tokens, start, end) {
  for (let index = start; index < end; index++) {
    const bang = tokens[index];
    if (bang.k !== 'p' || bang.v !== '!' || tokens[index + 1]?.k !== 'o') continue;
    const name = tokens[index - 1];
    if (name?.k === 'id' && !name.raw && POSITION_MACROS.has(name.v)) return 'macro';
    const close = tokens[index + 1].m;
    if (!Number.isInteger(close) || close >= end) continue;
    const spansLines = /[\n\r\u2028\u2029]/.test(text.slice(tokens[index + 1].s, tokens[close].e));
    if (spansLines && tokens.slice(index + 2, close).some((part) => part.k === 'lit' && part.nl)) return 'macro';
  }
  return null;
}

function bodyReason(text, tokens, fn) {
  const start = fn.body + 1;
  const end = fn.close;
  if (fn.isConst) return 'const';
  if (fn.isAsync) return 'async';
  if (fn.badReturn) return 'return-type';
  for (let index = start; index < end; index++) {
    if (isInnerAttribute(tokens, index)) return 'attribute';
    const token = tokens[index];
    if (token.k === 'doc' && (token.v.startsWith('//!') || token.v.startsWith('/*!'))) return 'attribute';
    if (isNestedItem(tokens, index)) return 'item';
  }
  const macro = macroReason(text, tokens, start, end);
  if (macro) return macro;
  if (tokens.slice(start, end).some((token) => token.k === 'lit' && token.nl)) return 'multiline';
  if (tokens.slice(start, end).some((token) => token.k === 'bad')) return 'unparsed';
  return null;
}

function renderTokens(source) {
  const tokens = lexRust(source);
  if (!matchDelimiters(tokens) || tokens.some((token) => token.k === 'bad')) throw new Error('unparsed');
  if (tokens.some((token) => token.k === 'lit' && token.nl)) throw new Error('multiline');
  let rendered = '';
  let previous = null;
  for (const token of tokens) {
    if (token.k === 'doc') continue;
    if (previous) rendered += previous.e === token.s ? '' : ' ';
    rendered += token.v;
    previous = token;
  }
  return rendered;
}

function replacementOk(replacement) {
  if (/[\n\r\u2028\u2029]/.test(replacement)) return false;
  const tokens = lexRust(replacement);
  if (tokens.some((token) => token.k === 'bad' || token.k === 'doc' || (token.k === 'lit' && token.nl))) return false;
  let at = 0;
  for (const token of [...tokens, { s: replacement.length, e: replacement.length }]) {
    if (replacement.slice(at, token.s).trim() !== '') return false;
    at = token.e;
  }
  return matchDelimiters(tokens);
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Put exact, whole-function-body variants behind `match path()`.
 * `budget` is the maximum rendered body size in bytes (generic functions count twice).
 * `insertions` lists where text was added, in coordinates of the ORIGINAL text: 1-based line, column in
 * Unicode scalar values of the insertion point (the position of the first character after the body's `{`),
 * and the inserted length in scalar values. Everything on that line at or after `column` moves right by
 * `length`; no other line moves.
 * @returns {{ text: string, switched: number[], refused: {number: number, reason: string}[], insertions: {line: number, column: number, length: number}[] }}
 */
export function bodyVariants(text, faults, { path = 'crate::__cupel_faults::active', budget = DEFAULT_BUDGET } = {}) {
  if (typeof text !== 'string') throw new TypeError('bodyVariants: text must be a string');
  if (!PATH_RE.test(path)) throw new TypeError(`bodyVariants: not a Rust path: ${path}`);
  if (!Number.isInteger(budget) || budget < 1) throw new TypeError('bodyVariants: budget must be a positive integer');

  const refused = [];
  const refuse = (number, reason) => refused.push({ number, reason });
  const tokens = lexRust(text);
  const balanced = matchDelimiters(tokens);
  const functions = balanced ? functionsIn(tokens) : [];
  const starts = lineStarts(text);
  const seen = new Set();
  const candidates = new Map();
  const ordered = [...(faults ?? [])].sort((left, right) => (left?.number ?? 0) - (right?.number ?? 0));

  for (const fault of ordered) {
    const number = fault?.number;
    if (!Number.isInteger(number) || number < 1 || number > 0xffffffff || seen.has(number)) { refuse(number, 'number'); continue; }
    seen.add(number);
    if (typeof fault.replacement !== 'string' || !replacementOk(fault.replacement)) { refuse(number, 'replacement'); continue; }
    const start = offsetOf(text, starts, fault.span?.start);
    const end = offsetOf(text, starts, fault.span?.end);
    if (start < 0 || end <= start) { refuse(number, 'span'); continue; }
    const enclosing = functions.filter((fn) => start >= tokens[fn.body].e && end <= tokens[fn.close].s);
    if (enclosing.length !== 1) { refuse(number, 'function'); continue; }
    const fn = enclosing[0];
    const list = candidates.get(fn) ?? [];
    list.push({ number, start, end, replacement: fault.replacement });
    candidates.set(fn, list);
  }

  const accepted = new Map();
  for (const [fn, list] of candidates) {
    const reason = bodyReason(text, tokens, fn);
    if (reason) { for (const fault of list) refuse(fault.number, reason); continue; }
    const bodyStart = tokens[fn.body].e;
    const bodyEnd = tokens[fn.close].s;
    const body = text.slice(bodyStart, bodyEnd);
    let original;
    try { original = renderTokens(body); } catch (error) {
      for (const fault of list) refuse(fault.number, error.message);
      continue;
    }
    const multiplier = fn.generic ? 2 : 1;
    if (byteLength(original) * multiplier > budget) { for (const fault of list) refuse(fault.number, 'budget'); continue; }
    const variants = [];
    for (const fault of list) {
      if (variants.length >= MAX_FAULTS) { refuse(fault.number, 'bound'); continue; }
      const relativeStart = fault.start - bodyStart;
      const relativeEnd = fault.end - bodyStart;
      let rendered;
      try {
        rendered = renderTokens(body.slice(0, relativeStart) + fault.replacement + body.slice(relativeEnd));
      } catch (error) {
        refuse(fault.number, error.message === 'multiline' ? 'multiline' : 'replacement');
        continue;
      }
      if (byteLength(rendered) * multiplier > budget) { refuse(fault.number, 'budget'); continue; }
      variants.push({ number: fault.number, rendered });
    }
    if (variants.length) accepted.set(fn, variants);
  }

  let renderedText = text;
  const insertions = [...accepted].sort(([left], [right]) => tokens[right.body].e - tokens[left.body].e);
  const placed = [];
  for (const [fn, variants] of insertions) {
    const arms = variants.map((variant) => `${variant.number} => return { ${variant.rendered} }`).join(', ');
    const insertion = `match ${path}() { ${arms}, _ => {} }`;
    const at = tokens[fn.body].e;
    renderedText = renderedText.slice(0, at) + insertion + renderedText.slice(at);
    let line = starts.length;
    while (starts[line - 1] > at) line--;
    placed.push({ line, column: [...text.slice(starts[line - 1], at)].length + 1, length: [...insertion].length });
  }
  placed.reverse();

  refused.sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
  const switched = [...accepted.values()].flat().map((fault) => fault.number).sort((left, right) => left - right);
  return { text: renderedText, switched, refused, insertions: placed };
}
