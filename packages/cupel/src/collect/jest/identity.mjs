import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { analyseTestFile } from '../node/testfile.mjs';
import { JestCollectorError } from './process.mjs';

const posix = p => p.split(sep).join('/');

function location(root, stack) {
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(/(\/[^():]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?$/);
    if (!match || match[1].includes('/node_modules/')) continue;
    const path = realpathSync(resolve(match[1]));
    const rel = posix(relative(root, path));
    if (rel === '..' || rel.startsWith('../')) continue;
    return { file: rel, line: Number(match[2]), column: Number(match[3]) };
  }
  throw new JestCollectorError('Jest registration stack has no project source location');
}

/** Attach K10 units and source analysis. Unresolved registration sites are errors. */
export function identifyTests(root, tests) {
  const definitions = new Map();
  const sites = new Map();
  for (const test of tests) {
    const at = location(root, test.stack);
    const key = `${test.file}\0${at.file}\0${at.line}\0${at.column}`;
    test.at = at;
    test.site = key;
    const group = sites.get(key) ?? [];
    group.push(test);
    sites.set(key, group);
  }
  const units = new Map();
  const titleCounts = new Map();
  for (const group of [...sites.values()].sort((a,b) =>
    a[0].at.file.localeCompare(b[0].at.file) || a[0].at.line - b[0].at.line || a[0].at.column - b[0].at.column)) {
    const first = group[0];
    if (group.length < 2) continue;
    const at = first.at;
    let unit;
    if (at.file !== first.file) {
      throw new JestCollectorError(`Jest helper registration identity is unsupported: ${at.file}:${at.line}`);
    } else {
      if (!definitions.has(at.file)) definitions.set(at.file, analyseTestFile(readFileSync(resolve(root, at.file), 'utf8')));
      const candidates = definitions.get(at.file).filter(d => d.line === at.line && d.column <= at.column);
      const definition = candidates.at(-1);
      if (!definition?.title) throw new JestCollectorError(`Jest parameterized title is unresolved at ${at.file}:${at.line}:${at.column}`);
      const suite = first.fullName.split(' > ').slice(0, -1).join(' > ');
      const title = [suite, definition.title].filter(Boolean).join(' > ');
      const key = `${first.file}::${title}`;
      const number = 1 + (titleCounts.get(key) ?? 0);
      titleCounts.set(key, number);
      unit = `${key}${number > 1 ? ` #${number}` : ''}`;
    }
    units.set(first.site, unit);
  }
  return tests.map(test => {
    const tags = [...new Set([...test.name.matchAll(/\[(critical|standard|minor)\]/g)].map(match => match[1]))].sort();
    return { id:test.id, file:test.file, name:test.name, ...(units.has(test.site) ? { unit:units.get(test.site) } : {}),
      ...(tags.length ? { tags } : {}), status:test.status, durationsMs:test.durationsMs,
      runStatuses:test.runStatuses, runner:'jest', ...(test.spawnsInterpreter ? { spawnsInterpreter:true } : {}) };
  }).sort((a,b) => a.id.localeCompare(b.id));
}
