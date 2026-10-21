// The node:test collector's pure parts: the line rule (K1), shapes (K12) and the strict brittleness detector
// with the S6 "next round" fixes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, coveredLines, formatLines, fallbackMask, lexerMask } from '../src/collect/node/lines.mjs';
import { positiveIntervals, unionIntervals } from '../src/collect/node/intervals.mjs';
import { analyseTestFile, fnv1a } from '../src/collect/node/testfile.mjs';

test('K1: comment and blank lines are not coverable; whitespace inside a template is not code', () => {
  const an = analyse('"a" // c\n/* x */\n`\n\n`\nx\n');
  assert.equal(an.lexer, 'shared');
  assert.deepEqual(an.coverable, [1, 3, 5, 6]);
});

test('K1: a line is covered only through a code character', () => {
  const src = 'f(); // tail\ng();\n';
  const an = analyse(src);
  const comment = src.indexOf('//');
  assert.deepEqual(coveredLines(an, [comment, src.indexOf('\n')]), []);
  assert.deepEqual(coveredLines(an, [0, 1, src.indexOf('g'), src.indexOf('g') + 1]), [1, 2]);
});

test('K1: the innermost range wins', () => {
  const fns = [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 10, endOffset: 20, count: 0 }] },
    { ranges: [{ startOffset: 12, endOffset: 15, count: 2 }] }];
  assert.deepEqual(positiveIntervals(fns), [0, 10, 12, 15, 20, 100]);
  assert.deepEqual(unionIntervals([0, 5, 10, 12], [4, 8, 20, 30]), [0, 8, 10, 12, 20, 30]);
});

test('K1: sources the lexer rejects fall back to the S2 scanner', () => {
  assert.throws(() => lexerMask('x = `unterminated\n'));
  const an = analyse('x = `unterminated\n');
  assert.equal(an.lexer, 'fallback');
  assert.deepEqual(an.coverable, [1]);
  assert.equal(fallbackMask('// c\n').some((b) => b), false);
});

test('line sets use the canonical form', () => {
  assert.equal(formatLines([1, 2, 3, 5, 7, 8]), '1-3,5,7-8');
  assert.equal(formatLines([]), '');
});

test('K12: FNV-1a over UTF-8, masked 4-token shingles of the body after the name', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  const [d] = analyseTestFile("test('n', () => { f(1); });\n");
  const shingles = ['( ) => {', ') => { f', '=> { f (', '{ f ( N', 'f ( N )', '( N ) ;', 'N ) ; }'];
  assert.deepEqual(d.shape, [...new Set(shingles.map(fnv1a))].sort((a, b) => a - b));
  const [a, b] = analyseTestFile("test('a', () => { f(1, 'x', `y`); g(/r/); });\ntest('b', () => { f(2, \"z\", `w`); g(/s/g); });\n");
  assert.deepEqual(a.shape, b.shape);
  assert.equal(a.line, 1);
  assert.equal(b.line, 2);
  assert.equal(b.column, 1);
});

const flags = (src) => analyseTestFile(src).map((d) => d.flags.map((f) => f.kind));

test('brittleness: an anchored source read with a literal assertion is a source-text pin', () => {
  assert.deepEqual(flags("test('x', () => {\n  const s = readFileSync(new URL('../src/a.mjs', import.meta.url), 'utf8');\n  assert.match(s, /export/);\n});\n"), [['source-text']]);
  assert.deepEqual(flags("const ROOT = fileURLToPath(new URL('..', import.meta.url));\nconst read = (p) => readFileSync(join(ROOT, p), 'utf8');\ntest('x', () => {\n  assert.ok(read('src/a.mjs').includes('export'));\n});\n"), [['source-text']]);
});

test('brittleness fix 1: reads under a temporary or fixture directory never count', () => {
  assert.deepEqual(flags("test('x', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'x-'));\n  const s = readFileSync(join(dir, 'src/out.mjs'), 'utf8');\n  assert.match(s, /export/);\n});\n"), [[]]);
  assert.deepEqual(flags("const FIX = new URL('./fixtures/', import.meta.url);\ntest('x', () => {\n  const s = readFileSync(new URL('a.mjs', FIX), 'utf8');\n  assert.match(s, /export/);\n});\n"), [[]]);
});

test('brittleness fix 2: a read wrapped in parse*/load* is data', () => {
  assert.deepEqual(flags("test('x', () => {\n  const cfg = parseConfig(readFileSync(new URL('../src/a.mjs', import.meta.url), 'utf8'));\n  assert.match(cfg.name, /a/);\n});\n"), [[]]);
});

test('brittleness fix 3: snapshot APIs only as member calls', () => {
  assert.deepEqual(flags("function snapshot(x) { return x; }\ntest('x', () => {\n  assert.ok(snapshot(1));\n});\n"), [[]]);
  assert.deepEqual(flags("test('x', (t) => {\n  t.assert.snapshot(render());\n});\n"), [['file-snapshot']]);
});

test('brittleness fix 4: no second-order taint through an object literal', () => {
  const head = "const SRC = readFileSync(new URL('../src/a.mjs', import.meta.url), 'utf8');\n";
  assert.deepEqual(flags(`${head}const input = { text: SRC };\ntest('x', () => {\n  assert.match(run(input), /ok/);\n});\n`), [[]]);
  assert.deepEqual(flags(`${head}const lines = SRC.split('\\n');\ntest('x', () => {\n  assert.ok(lines.includes('export'));\n});\n`), [['source-text']]);
});

test('brittleness: a whole-file read inside an equality assertion is a file snapshot', () => {
  assert.deepEqual(flags("test('x', () => {\n  assert.equal(render(), readFileSync(new URL('../docs/out.md', import.meta.url), 'utf8'));\n});\n"), [['file-snapshot']]);
});
