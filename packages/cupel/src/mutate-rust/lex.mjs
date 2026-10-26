import { refuse } from './errors.mjs';

// This is a closed lexical vocabulary. Raw strings, Unicode identifiers, byte
// literals, token-tree extensions, and unknown punctuation refuse explicitly.
export function lexRust(text, file) {
  const tokens = []; let at = 0, line = 1, column = 1;
  const fail = (why) => refuse('unsupported-rust-syntax', `${file}:${line}:${column}: ${why}`);
  const advance = (value) => { for (const c of value) { if (c === '\n') { line++; column = 1; } else column++; } at += value.length; };
  while (at < text.length) {
    const tail = text.slice(at);
    const space = /^\s+/.exec(tail); if (space) { advance(space[0]); continue; }
    if (tail.startsWith('///') || tail.startsWith('//!')) fail('documentation comments/doctests are outside the profile');
    if (tail.startsWith('//')) { advance(tail.split('\n')[0]); continue; }
    if (tail.startsWith('/*')) fail('block comments are outside the profile');
    let value, kind;
    if (tail[0] === '"') {
      const m = /^"(?:[^"\\\r\n]|\\(?:["\\nrt0]|x[0-9a-fA-F]{2}))*"/.exec(tail);
      if (!m) fail('unsupported string escape or unclosed string');
      value = m[0]; kind = 'string';
    } else if (tail.startsWith("'static")) { value = "'static"; kind = 'lifetime'; }
    else {
      const number = /^(?:0|[1-9][0-9]*)(?:u8|u16|u32|u64|usize|i8|i16|i32|i64|isize)?\b/.exec(tail);
      const ident = /^[A-Za-z_][A-Za-z_0-9]*/.exec(tail);
      if (number) { value = number[0]; kind = 'number'; }
      else if (ident) { value = ident[0]; kind = 'ident'; }
      else { value = /^(?:->|::|==|!=|<=|>=|&&|\|\||[{}()[\],;:.#&!+*\/=<>%-])/.exec(tail)?.[0]; kind = 'punct'; }
    }
    if (!value) fail('unrecognized token');
    if (tokens.length >= 50_000) fail('token bound exceeded');
    tokens.push({ value, kind, start: at, end: at + value.length, line, column }); advance(value);
  }
  return tokens;
}
