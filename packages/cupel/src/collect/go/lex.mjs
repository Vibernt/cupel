// Go-aware lexical scan shared by the line classifier and test-body analysis.
export function scanGo(source) {
  const code = Array(source.length).fill(false);
  const tokens = [];
  let i = 0;
  let line = 1;
  const take = (end, value, kind = 'code') => {
    const start = i;
    for (; i < end; i++) {
      if (kind !== 'comment' && !/\s/u.test(source[i])) code[i] = true;
      if (source[i] === '\n') line++;
    }
    if (kind !== 'comment' && value) tokens.push({ value, raw: source.slice(start, end), start, end, line: line - (source.slice(start, end).match(/\n/g)?.length ?? 0) });
  };
  while (i < source.length) {
    const c = source[i];
    if (source.startsWith('//', i)) { let j = source.indexOf('\n', i); take(j < 0 ? source.length : j, null, 'comment'); }
    else if (source.startsWith('/*', i)) { const j = source.indexOf('*/', i + 2); take(j < 0 ? source.length : j + 2, null, 'comment'); }
    else if (c === '"' || c === '\'' || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (c !== '`' && source[j] === '\\') { j += 2; continue; }
        if (source[j++] === c) break;
      }
      take(j, 'S');
    } else if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (/[A-Za-z_0-9]/.test(source[j] ?? '')) j++; take(j, source.slice(i, j)); }
    else if (/[0-9]/.test(c)) { let j = i + 1; while (/[A-Za-z_0-9.]/.test(source[j] ?? '')) j++; take(j, 'N'); }
    else if (/\s/.test(c)) take(i + 1, null);
    else take(i + 1, c);
  }
  const lines = new Set();
  let current = 1;
  for (let p = 0; p < code.length; p++) {
    if (code[p]) lines.add(current);
    if (source[p] === '\n') current++;
  }
  return { tokens, codeLines: lines, code };
}

export function shape(tokens) {
  const values = tokens.map((t) => t.value);
  const hashes = new Set();
  for (let i = 0; i + 4 <= values.length; i++) {
    let h = 2166136261;
    for (const byte of Buffer.from(values.slice(i, i + 4).join(' '))) h = Math.imul(h ^ byte, 16777619) >>> 0;
    hashes.add(h);
  }
  return [...hashes].sort((a, b) => a - b);
}
