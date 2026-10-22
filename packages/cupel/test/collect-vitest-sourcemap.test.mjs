import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVlq, decodeMappings, inlineSourceMap, mappedLines } from '../src/collect/vitest/sourcemap.mjs';
import { sourceMapLines } from '../src/collect/vitest/sources.mjs';
import { analyse } from '../src/collect/node/lines.mjs';

test('VLQ decodes signed deltas and rejects incomplete digits', () => {
  assert.deepEqual(decodeVlq('A,C,D,2B'.replaceAll(',', '')), [0, 1, -1, 27]);
  assert.throws(() => decodeVlq('g'), /incomplete/);
  assert.throws(() => decodeVlq('!'), /invalid/);
});

test('inline source map sends covered generated spans to original lines', () => {
  const map = { version: 3, sources: ['math.ts'], names: [], mappings: 'AAAA;AACA;AACA' };
  const encoded = Buffer.from(JSON.stringify(map)).toString('base64');
  const evaluated = `const a = 1;\nconst b = 2;\nconst c = 3;\n//# sourceMappingURL=data:application/json;base64,${encoded}`;
  assert.deepEqual(decodeMappings(map.mappings).map((line) => line[0].originalLine), [0, 1, 2]);
  const loaded = inlineSourceMap(evaluated);
  assert.deepEqual(mappedLines(evaluated, [13, 24, 26, 37], loaded), [2, 3]);
});

test('a mismatched TypeScript map logs the file for omission; unchanged JavaScript uses original offsets', () => {
  const map = Buffer.from(JSON.stringify({ version: 3, sources: ['other.ts'], names: [], mappings: 'AAAA' })).toString('base64');
  const root = '/project';
  const ts = 'export const n: number = 1';
  const logs = [];
  const source = new Map([['src/value.ts', { text: ts, an: analyse('export const n         = 1') }]]);
  const script = { url: '/project/src/value.ts', source: `export const n = 1\n//# sourceMappingURL=data:application/json;base64,${map}` };
  assert.deepEqual(sourceMapLines(root, script, [0, 18], source, (text) => logs.push(text)), ['src/value.ts', null]);
  assert.match(logs[0], /mapping skipped for src\/value\.ts/);
  const js = 'export const n = 1';
  assert.deepEqual(sourceMapLines(root, { url: '/project/src/value.js', source: js }, [0, js.length],
    new Map([['src/value.js', { text: js, an: analyse(js) }]]), () => {}), ['src/value.js', [1]]);
});
