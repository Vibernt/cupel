// Whole-body replacements for the S10a function-scope experiment.
import { createHash } from 'node:crypto';
import { tokenize, matchBrackets } from '../lang/js/lexer.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function apparentDefault(tokens, pairs, from, to, text) {
  const head = text.slice(Math.max(0, tokens[from].start - 100), tokens[from].start);
  const typed = head.match(/:\s*(boolean|number|string|void|undefined|object|unknown|any|[\w]+\[\])\s*$/);
  if (typed) {
    if (typed[1] === 'boolean') return 'false';
    if (typed[1] === 'number') return '0';
    if (typed[1] === 'string') return "''";
    if (typed[1].endsWith('[]')) return '[]';
    if (typed[1] === 'object') return '{}';
    return null;
  }
  for (let k = from + 1; k < to; k++) {
    if (['{', '(', '['].includes(tokens[k].value) && pairs.has(k)) {
      k = pairs.get(k);
      continue;
    }
    if (tokens[k].value !== 'return') continue;
    const next = tokens[k + 1];
    if (!next || next.value === ';' || next.value === '}') continue;
    if (next.type === 'num') return '0';
    if (next.type === 'string' || next.type === 'template') return "''";
    if (next.value === 'true' || next.value === 'false') return 'false';
    if (next.value === '[') return '[]';
    if (next.value === '{') return '{}';
    if (next.value === 'null') return 'null';
    if (['*', '/', '-', '%'].includes(tokens[k + 2]?.value)) return '0';
  }
  return null;
}

function topStatements(tokens, pairs, open, close) {
  let count = 0;
  for (let k = open + 1; k < close; k++) {
    if (k === open + 1 || [';', '}'].includes(tokens[k - 1].value)) count++;
    if (['(', '[', '{'].includes(tokens[k].value) && pairs.has(k)) k = pairs.get(k);
  }
  return count;
}

export function bodySites(source, text, scannedTokens = null, scannedPairs = null) {
  const tokens = scannedTokens ?? tokenize(text);
  const pairs = scannedPairs ?? matchBrackets(tokens);
  const out = [];
  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open].value !== '{' || !pairs.has(open)) continue;
    const close = pairs.get(open);
    const before = tokens[open - 1];
    let kind = null;
    let name = null;
    let generator = false;
    if (before?.value === '=>') {
      kind = 'arrow';
      for (let p = open - 2; p >= Math.max(0, open - 20); p--) {
        if (tokens[p].value === '=') { name = tokens[p - 1]?.type === 'name' ? tokens[p - 1].value : null; break; }
        if ([';', '{', '}'].includes(tokens[p].value)) break;
      }
    } else {
      let p = open - 1;
      if (before?.value !== ')') {
        // TypeScript return annotation between the parameter list and body.
        while (p >= 0 && p > open - 12 && tokens[p].value !== ')') p--;
      }
      if (tokens[p]?.value === ')' && pairs.has(p)) {
        const start = pairs.get(p);
        const label = tokens[start - 1];
        const marker = tokens[start - 2];
        generator = marker?.value === '*';
        if (label?.value === 'function' || marker?.value === 'function' || tokens[start - 3]?.value === 'function') {
          kind = 'function'; name = label?.value === 'function' ? null : label?.value;
          if (!name && marker?.value === '=') name = tokens[start - 3]?.value;
        } else if (label?.type === 'name' && !CONTROL.has(label.value)) {
          if (marker?.value === '.' || marker?.value === '?.') continue;
          kind = ['get', 'set'].includes(marker?.value) ? marker.value : 'method';
          name = label.value;
        }
      }
    }
    if (!kind || generator || name === 'constructor' || topStatements(tokens, pairs, open, close) < 2) continue;
    const first = tokens[open + 1];
    if (!first || first.start >= tokens[close].start) continue;
    const key = `${source}:${tokens[open].line}:${tokens[open].col + 1}`;
    const variants = ['return;', apparentDefault(tokens, pairs, open, close, text)];
    const replacements = [variants[0]];
    if (variants[1] !== null && variants[1] !== 'undefined') replacements.push(`return ${variants[1]};`);
    for (let variant = 0; variant < replacements.length; variant++) {
      const replacement = replacements[variant];
      const edits = [{ start: tokens[open].end, end: tokens[close].start, text: ` ${replacement} ` }];
      out.push({
        id: `${source}:${first.line}:${first.col + 1}:body-replace:${hash([key, variant, replacement])}`,
        source, operator: 'body-replace', line: first.line, col: first.col + 1,
        start: first.start, original: kind, replacement, edits, filtered: null,
        functionKey: key, functionName: name ?? `<${kind}@${tokens[open].line}>`,
        startLine: first.line, endLine: tokens[close].line, variant,
      });
    }
  }
  return out;
}
