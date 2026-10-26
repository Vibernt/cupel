import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmp } from '../../../engine/order.mjs';
import { analyseTestFile, patternFindings } from '../../../collect/node/testfile.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sortedObject = entries => Object.fromEntries([...entries].sort((a, b) => cmp(a[0], b[0])));
const TIER_TAG = /\[(critical|standard|minor)\]/g;
const JS_LANGUAGE = /^(js|javascript|node|nodejs|mjs|cjs|typescript|ts)$/i;

function definitions(root, manifest, file, cache) {
  if (!Object.hasOwn(manifest, file)) throw new Error(`profile test definition is outside input manifest: ${file}`);
  if (!cache.has(file)) {
    const bytes = readFileSync(join(root, file));
    if (sha(bytes) !== manifest[file]) throw new Error(`profile test definition changed: ${file}`);
    const text = bytes.toString('utf8');
    cache.set(file, { text, byLocation: new Map(analyseTestFile(text).map(def =>
      [`${def.line}:${def.column}`, def])) });
  }
  return cache.get(file);
}

function configuredPatterns(config) {
  return (config?.brittleness?.patterns ?? []).filter(pattern =>
    !pattern.language || JS_LANGUAGE.test(pattern.language)).map(pattern => ({
    kind: pattern.kind, deliberate: pattern.deliberate === true,
    re: new RegExp(pattern.pattern, 'm'),
  }));
}

/** Produce canonical test rows, units, shapes and brittleness from verified reporter call sites. */
export function profileTestRows(root, manifest, attempts, config = {}) {
  const first = attempts[0].rows;
  const records = first.map(row => ({ ...row, durationsMs: [], runStatuses: [] }));
  for (const attempt of attempts) {
    if (attempt.rows.length !== records.length || attempt.rows.some((row, index) =>
        row.canonicalId !== records[index].canonicalId || row.callFile !== records[index].callFile ||
        row.line !== records[index].line || row.column !== records[index].column))
      throw new Error('profile test identities changed between runs');
    for (let index = 0; index < records.length; index++) {
      const record = records[index], row = attempt.rows[index];
      if ((record.status === 'skipped') !== (row.status === 'skipped'))
        throw new Error('profile skipped or executed test identity changed between runs');
      record.durationsMs.push(Math.max(0, Math.round(row.ms)));
      record.runStatuses.push(row.status);
      if (row.status === 'failed') record.status = 'failed';
    }
  }
  const cache = new Map(), groups = new Map();
  for (const row of records) {
    const def = definitions(root, manifest, row.callFile, cache).byLocation.get(`${row.line}:${row.column}`);
    if (!def) throw new Error(`profile test definition missing at ${row.callFile}:${row.line}:${row.column}`);
    row.definition = def;
    const key = `${row.file}\0${row.callFile}\0${row.line}\0${row.column}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const titleCounts = new Map();
  for (const rows of [...groups.values()].sort((a, b) =>
      cmp(a[0].file, b[0].file) || a[0].line - b[0].line || a[0].column - b[0].column)) {
    const row = rows[0];
    if (rows.length < 2) {
      const key = `${row.file}::${row.fullName}`;
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
      continue;
    }
    if (row.definition.title == null) throw new Error('profile repeated definition lacks a static title');
    const key = `${row.file}::${row.callFile === row.file ? '' : `@${row.callFile}::`}${[...row.path, row.definition.title].join(' > ')}`;
    const count = (titleCounts.get(key) ?? 0) + 1;
    titleCounts.set(key, count);
    for (const item of rows) item.unit = `${key}${count > 1 ? ` #${count}` : ''}`;
  }
  const patterns = configuredPatterns(config);
  const brittleness = [], shapes = new Map();
  for (const row of records) {
    const text = cache.get(row.callFile).text;
    const seen = new Set();
    for (const finding of [...row.definition.flags,
        ...patternFindings(text, row.definition, patterns)]) {
      const key = `${finding.kind}\0${finding.line}\0${finding.deliberate === true}`;
      if (seen.has(key)) continue;
      seen.add(key);
      brittleness.push({ test: row.canonicalId, kind: finding.kind, line: finding.line,
        ...(finding.deliberate ? { deliberate: true } : {}) });
    }
    shapes.set(row.unit ?? row.canonicalId, row.definition.shape);
  }
  brittleness.sort((a, b) => cmp(a.test, b.test) || cmp(a.kind, b.kind) ||
    a.line - b.line || Number(a.deliberate === true) - Number(b.deliberate === true));
  const tests = records.sort((a, b) => cmp(a.canonicalId, b.canonicalId)).map(row => {
    const tags = [...new Set([...row.name.matchAll(TIER_TAG)].map(match => match[1]))].sort(cmp);
    return { id: row.canonicalId, file: row.file, name: row.name,
      ...(row.unit ? { unit: row.unit } : {}), ...(tags.length ? { tags } : {}),
      status: row.status, durationsMs: row.durationsMs, runStatuses: row.runStatuses };
  });
  return { tests, brittleness, shapes: sortedObject(shapes) };
}
