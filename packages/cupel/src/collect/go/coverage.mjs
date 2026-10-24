import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { scanGo } from './lex.mjs';

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

export function profile(file, packages, root, cache) {
  const text = readFileSync(file, 'utf8').trimEnd().split('\n');
  if (text.shift() !== 'mode: count') throw new Error(`Go coverprofile is not mode: count: ${file}`);
  const byFile = new Map();
  for (const row of text) {
    const m = /^(.*):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/.exec(row);
    if (!m) throw new Error(`bad Go coverprofile row: ${row}`);
    const [, path, start, , end, endCol, , count] = m;
    const pkg = packages.find((p) => path === p.ImportPath || path.startsWith(`${p.ImportPath}/`));
    if (!pkg) throw new Error(`Go coverprofile path has no local package: ${path}`);
    const suffix = path.slice(pkg.ImportPath.length).replace(/^\//, '');
    const abs = join(pkg.Dir, suffix);
    const rel = relative(root, abs).split(sep).join('/');
    if (rel.startsWith('../') || rel.startsWith('/') || rel.split('/').some((part) => part.startsWith('.') || ['vendor', 'testdata'].includes(part)) || rel.endsWith('_test.go')) continue;
    let source = cache.get(rel);
    if (!source) {
      const text = readFileSync(abs, 'utf8');
      source = { text, code: scanGo(text).code, lineStarts: [0] };
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') source.lineStarts.push(i + 1);
      cache.set(rel, source);
    }
    const lines = byFile.get(rel) ?? { all: new Set(), covered: new Set(), blocks: new Map() };
    const byteColumn = (line, column) => source.lineStarts[line - 1] + Buffer.from(source.text.slice(source.lineStarts[line - 1]).split('\n', 1)[0]).subarray(0, column - 1).toString().length;
    const from = byteColumn(Number(start), Number(m[3]));
    const to = byteColumn(Number(end), Number(endCol));
    const touched = new Set();
    let line = Number(start);
    for (let i = from; i < to; i++) {
      if (source.code[i]) touched.add(line);
      if (source.text[i] === '\n') line++;
    }
    for (const n of touched) {
      lines.all.add(n);
      if (Number(count) > 0) lines.covered.add(n);
    }
    lines.blocks.set(`${start}.${m[3]},${end}.${endCol}`, { count: Number(count), touched });
    byFile.set(rel, lines);
  }
  return byFile;
}

export function covered(profileMap) {
  return Object.fromEntries([...profileMap].filter(([, v]) => v.covered.size).sort(([a], [b]) => (a > b) - (a < b)).map(([p, v]) => [p, lineSet(v.covered)]));
}

export function subtract(actual, setup) {
  return Object.fromEntries([...actual].map(([p, v]) => {
    const lines = new Set();
    for (const [key, block] of v.blocks) {
      if (block.count > (setup.get(p)?.blocks.get(key)?.count ?? 0)) for (const n of block.touched) lines.add(n);
    }
    return [p, lineSet(lines)];
  }).filter(([, v]) => v));
}

export function combineRuns(records, unstable) {
  const expanded = records.map((record) => new Map(Object.entries(record).map(([source, spec]) => [source, new Set(spec.split(',').filter(Boolean).flatMap((part) => {
    const [start, end = start] = part.split('-').map(Number);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }))])));
  const result = {};
  for (const source of new Set(expanded.flatMap((record) => [...record.keys()]))) {
    const union = new Set(expanded.flatMap((record) => [...(record.get(source) ?? [])]));
    result[source] = lineSet(union);
    if (records.length > 1) for (const line of union) {
      if (expanded.some((record) => !record.get(source)?.has(line))) {
        if (!unstable.has(source)) unstable.set(source, new Set());
        unstable.get(source).add(line);
      }
    }
  }
  return result;
}
