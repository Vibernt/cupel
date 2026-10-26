import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { scanRust } from './lex.mjs';

export function lineSet(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges.map(([a, b]) => a === b ? String(a) : `${a}-${b}`).join(',');
}

export function exportLines(exportJson, root) {
  const files = new Map();
  for (const block of exportJson.data ?? []) for (const file of block.files ?? []) mapExportFile(files, file, root);
  return files;
}

export function mapExportFile(files, file, root) {
    const abs = isAbsolute(file.filename) ? file.filename : resolve(root, file.filename);
    const path = relative(root, abs).split(sep).join('/');
    if (path.startsWith('../') || path.startsWith('/') || !existsSync(abs)) return;
    const parts = path.split('/');
    if (!parts.includes('src') || parts.some((part) => part.startsWith('.') || ['target', 'tests', 'benches', 'examples', 'vendor'].includes(part))) return;
    if (!path.endsWith('.rs')) return;
    const source = readFileSync(abs, 'utf8');
    const code = scanRust(source, { tokens: false }).code;
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    let cachedLine = -1; let cachedBytes;
    const position = (line, column) => {
      const start = starts[line - 1];
      if (start === undefined) return source.length;
      if (line !== cachedLine) {
        const end = line < starts.length ? starts[line] - 1 : source.length;
        cachedBytes = Buffer.from(source.slice(start, end));
        cachedLine = line;
      }
      return start + cachedBytes.subarray(0, column - 1).toString().length;
    };
    const record = files.get(path) ?? { all: new Set(), covered: new Set() };
    const segments = file.segments ?? [];
    for (let index = 0; index < segments.length; index++) {
      const [line, column, count, hasCount, , isGap] = segments[index];
      if (!hasCount || isGap) continue;
      const from = position(line, column);
      const next = segments[index + 1];
      const to = next ? position(next[0], next[1]) : source.length;
      let currentLine = line;
      for (let i = from; i < to; i++) {
        if (code[i]) { record.all.add(currentLine); if (count > 0) record.covered.add(currentLine); }
        if (source[i] === '\n') currentLine++;
      }
    }
    files.set(path, record);
}

export function covered(files) {
  return Object.fromEntries([...files].filter(([, lines]) => lines.covered.size)
    .sort(([a], [b]) => a.localeCompare(b)).map(([path, lines]) => [path, lineSet(lines.covered)]));
}

export function combineRuns(records, unstable) {
  const expanded = records.map((record) => new Map(Object.entries(record).map(([path, spec]) => [path, new Set(spec.split(',').filter(Boolean).flatMap((part) => {
    const [start, end = start] = part.split('-').map(Number);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }))])));
  const result = {};
  for (const path of new Set(expanded.flatMap((record) => [...record.keys()]))) {
    const union = new Set(expanded.flatMap((record) => [...(record.get(path) ?? [])]));
    result[path] = lineSet(union);
    if (records.length > 1) for (const line of union) if (expanded.some((record) => !record.get(path)?.has(line))) {
      if (!unstable.has(path)) unstable.set(path, new Set());
      unstable.get(path).add(line);
    }
  }
  return result;
}
