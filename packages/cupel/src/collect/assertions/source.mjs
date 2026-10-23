import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../lang/js/lexer.mjs';

// Normalise whitespace/comments only: keep literals, identifiers and punctuation intact.
export const normalise = (tokens) => tokens.map((t) => t.value).join(' ');
function argumentsAt(tokens, open) {
  const args = [], stack = [];
  let start = open + 1;
  for (let i = start; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (!stack.length && (v === ',' || v === ')')) {
      args.push(tokens.slice(start, i)); start = i + 1;
      if (v === ')') return { args, end: i };
    } else if (['(', '[', '{'].includes(v)) stack.push(v);
    else if ([')', ']', '}'].includes(v)) stack.pop();
  }
  return null;
}
export function sourceReader(root) {
  const cache = new Map();
  return (stack, matcher, framework) => {
    for (const line of stack.split('\n').slice(1)) {
      const m = line.match(/(?:\(|\s)((?:file:\/\/\/|\/).*?):(\d+):(\d+)\)?$/);
      if (!m) continue;
      const abs = m[1].startsWith('file:') ? fileURLToPath(m[1]) : m[1];
      const file = relative(root, abs).split(sep).join('/');
      if (file.startsWith('../') || file.includes('/node_modules/') || file.startsWith('node_modules/') || file.startsWith('.scratch/')) continue;
      const site = { file, line: Number(m[2]), column: Number(m[3]) };
      if (!cache.has(abs)) cache.set(abs, tokenize(readFileSync(resolve(abs), 'utf8')));
      const tokens = cache.get(abs);
      let at = tokens.findIndex((t) => t.line === site.line && t.col >= site.column - 1);
      if (at < 0) return { site, subject: null, expectedExpression: null };
      if (framework === 'vitest') {
        // Vitest points at the matcher; walk back only across a single expect(...).modifier chain.
        for (let i = at; i >= 0; i--) {
          if (tokens[i].value !== 'expect' || tokens[i + 1]?.value !== '(') continue;
          const candidate = argumentsAt(tokens, i + 1);
          if (!candidate) continue;
          const chain = tokens.slice(candidate.end + 1, at + 1);
          if (i === at || (chain.length && chain.every((t) => ['.', 'not', 'resolves', 'rejects', matcher].includes(t.value)))) at = i;
          break;
        }
      }
      // A stack location identifies the call. Only accept an unambiguous call starting there.
      const end = tokens.findIndex((t, i) => i >= at && t.value === '(');
      if (end < 0 || end - at > 6) return { site, subject: null, expectedExpression: null };
      const call = argumentsAt(tokens, end);
      if (!call) return { site, subject: null, expectedExpression: null };
      let args = call.args;
      if (framework === 'vitest') {
        // V8 usually points at expect(), but can point at the matcher instead.
        if (!tokens.slice(at, end).some((t) => t.value === 'expect')) return { site, subject: null, expectedExpression: null };
        const next = tokens.findIndex((t, i) => i > call.end && t.value === matcher);
        const expected = next >= 0 && tokens[next + 1]?.value === '(' ? argumentsAt(tokens, next + 1)?.args[0] : null;
        return { site, subject: normalise(args[0]), expectedExpression: expected ? normalise(expected) : null };
      }
      return { site, subject: normalise(args[0]), expectedExpression: args[1] ? normalise(args[1]) : null };
    }
    return { site: null, subject: null, expectedExpression: null };
  };
}
