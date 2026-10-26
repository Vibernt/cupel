import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseTestFile } from '../node/testfile.mjs';
import { JestCollectorError } from './process.mjs';

/** Static K12 shapes and the strictly observed brittleness hints of Jest definitions. */
export function jestSignals(root, raw, tests) {
  const byId = new Map(tests.map(t => [t.id, t]));
  const parsed = new Map();
  const shapes = {};
  const brittleness = [];
  for (const row of raw) {
    const at = row.at;
    if (!at || at.file !== row.file) throw new JestCollectorError(`Jest source definition is unresolved for ${row.id}`);
    if (!parsed.has(row.file)) {
      const text = readFileSync(join(root, row.file), 'utf8');
      parsed.set(row.file, { text, definitions:analyseTestFile(text) });
    }
    const { text, definitions } = parsed.get(row.file);
    const definition = definitions.filter(d => d.line === at.line && d.column <= at.column).at(-1);
    if (!definition) throw new JestCollectorError(`Jest source definition is unresolved at ${row.file}:${at.line}:${at.column}`);
    const id = byId.get(row.id)?.unit ?? row.id;
    if (shapes[id] && JSON.stringify(shapes[id]) !== JSON.stringify(definition.shape))
      throw new JestCollectorError(`Jest unit ${id} has inconsistent test bodies`);
    shapes[id] = definition.shape;
    for (const flag of definition.flags) brittleness.push({ test:row.id, kind:flag.kind, line:flag.line });
    const body = text.slice(definition.start, definition.end);
    if (/\breadFile(?:Sync)?\s*\(/.test(body) && /\bexpect\s*\(/.test(body) &&
        /\.(?:toContain|toMatch|toEqual|toBe)\s*\(/.test(body) && /(?:\/src\/|\.ts['"`]|\.js['"`])/.test(body) &&
        !brittleness.some(flag => flag.test === row.id && flag.kind === 'source-text'))
      brittleness.push({ test:row.id, kind:'source-text', line:at.line });
  }
  brittleness.sort((a,b) => a.test.localeCompare(b.test) || a.line - b.line || a.kind.localeCompare(b.kind));
  return { shapes:Object.fromEntries(Object.entries(shapes).sort(([a],[b]) => a.localeCompare(b))), brittleness };
}
