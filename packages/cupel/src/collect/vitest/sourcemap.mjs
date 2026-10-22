// Minimal source-map v3 decoder. Generated coordinates are zero based UTF-16 columns.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeVlq(text) {
  const values = [];
  let value = 0, shift = 0;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`invalid VLQ character ${JSON.stringify(char)}`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) { shift += 5; if (shift > 50) throw new Error('VLQ is too long'); continue; }
    values.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0; shift = 0;
  }
  if (shift) throw new Error('incomplete VLQ');
  return values;
}

export function decodeMappings(mappings) {
  const lines = [];
  let source = 0, originalLine = 0, originalColumn = 0, name = 0;
  for (const encodedLine of mappings.split(';')) {
    let column = 0;
    const line = [];
    for (const encoded of encodedLine.split(',')) {
      if (!encoded) continue;
      const fields = decodeVlq(encoded);
      if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) throw new Error('invalid source-map segment');
      column += fields[0];
      if (fields.length > 1) {
        source += fields[1]; originalLine += fields[2]; originalColumn += fields[3];
        if (fields.length === 5) name += fields[4];
        line.push({ column, source, originalLine, originalColumn });
      } else line.push({ column });
    }
    lines.push(line);
  }
  return lines;
}

export function inlineSourceMap(evaluated) {
  const match = evaluated.match(/(?:\/\/[#@]\s*sourceMappingURL=)(data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+))/g)?.at(-1);
  if (!match) throw new Error('evaluated script has no inline source map');
  const encoded = match.slice(match.indexOf('base64,') + 7);
  const map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string') throw new Error('invalid source map');
  return { ...map, decoded: decodeMappings(map.mappings) };
}

/** Map covered generated ranges to original line numbers. Unmapped spans are ignored. */
export function mappedLines(evaluated, intervals, map, sourceIndex = 0) {
  const starts = [0];
  for (let i = 0; i < evaluated.length; i++) if (evaluated[i] === '\n') starts.push(i + 1);
  const hit = new Set();
  for (let line = 0; line < map.decoded.length; line++) {
    const segments = map.decoded[line];
    const start = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] : evaluated.length;
    if (start === undefined) break;
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k];
      if (seg.source !== sourceIndex) continue;
      const a = start + seg.column;
      const b = Math.min(end, start + (segments[k + 1]?.column ?? end - start));
      if (intervals.some((v, i) => i % 2 === 0 && v < b && intervals[i + 1] > a)) hit.add(seg.originalLine + 1);
    }
  }
  return [...hit].sort((a, b) => a - b);
}
