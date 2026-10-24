// Keeps byte offsets and source lines while masking Rust comments and literal values.
export function scanRust(source) {
  const tokens = []; const codeLines = new Set(); const code = Array(source.length).fill(false);
  let i = 0; let line = 1;
  function take(end, value, kind = 'code') {
    const start = i; const firstLine = line;
    for (; i < end; i++) {
      if (kind !== 'comment' && !/\s/u.test(source[i])) { codeLines.add(line); code[i] = true; }
      if (source[i] === '\n') line++;
    }
    if (value !== null) tokens.push({ value, raw: source.slice(start, end), start, end, line: firstLine });
  }
  while (i < source.length) {
    const c = source[i];
    if (source.startsWith('//', i) || (i === 0 && source.startsWith('#!', i))) {
      const end = source.indexOf('\n', i); take(end < 0 ? source.length : end, null, 'comment');
    } else if (source.startsWith('/*', i)) {
      let depth = 1; let j = i + 2;
      while (j < source.length && depth) {
        if (source.startsWith('/*', j)) { depth++; j += 2; }
        else if (source.startsWith('*/', j)) { depth--; j += 2; }
        else j++;
      }
      take(j, null, 'comment');
    } else if ((c === 'r' || c === 'b') && /^r#*"|^br#*"|^rb#*"/.test(source.slice(i))) {
      const match = /^(?:br|rb|r)(#*)"/.exec(source.slice(i));
      const close = `"${match[1]}`;
      const end = source.indexOf(close, i + match[0].length);
      take(end < 0 ? source.length : end + close.length, 'S');
    } else if (c === '"' || (c === 'b' && source[i + 1] === '"')) {
      let j = i + (c === 'b' ? 2 : 1);
      while (j < source.length) { if (source[j] === '\\') { j += 2; continue; } if (source[j++] === '"') break; }
      take(j, 'S');
    } else if (c === "'" && /^'(?:\\.|[^'\\])'/.test(source.slice(i))) {
      const match = /^'(?:\\.|[^'\\])'/.exec(source.slice(i)); take(i + match[0].length, 'S');
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1; while (/[A-Za-z_0-9]/.test(source[j] ?? '')) j++; take(j, source.slice(i, j));
    } else if (/[0-9]/.test(c)) {
      let j = i + 1; while (/[A-Za-z_0-9.]/.test(source[j] ?? '')) j++; take(j, 'N');
    } else if (/\s/.test(c)) take(i + 1, null);
    else take(i + 1, c);
  }
  return { tokens, codeLines, code };
}

export function shape(tokens) {
  const values = tokens.map((token) => token.value);
  const hashes = new Set();
  for (let i = 0; i + 4 <= values.length; i++) {
    let hash = 2166136261;
    for (const byte of Buffer.from(values.slice(i, i + 4).join(' '))) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    hashes.add(hash);
  }
  return [...hashes].sort((a, b) => a - b);
}
