// Line sets (3.1), tokens, words and globs (section 5), ordering and exact ratios (R2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, format, union, diff, intersect, size, exclusiveLines, mapFrom, mapToObject } from '../src/engine/lines.mjs';
import { tokens, wordMatches, globMatches } from '../src/engine/match.mjs';
import { cmp } from '../src/engine/order.mjs';
import { pct, ratioAtLeast, decimal } from '../src/engine/rational.mjs';

const canon = (s) => format(parse(s).set);

test('3.1 line sets: canonical form merges, sorts and drops single-line ranges', () => {
  assert.equal(canon(''), '');
  assert.equal(canon('7-7'), '7');
  assert.equal(canon('10-12,1-3,7'), '1-3,7,10-12');
  assert.equal(canon('1-3,2-5'), '1-5'); // overlapping
  assert.equal(canon('1-3,4-6'), '1-6'); // adjacent
  assert.equal(canon('5,3,4'), '3-5');
  assert.equal(canon('1-1000000,7'), '1-1000000');
});

test('3.1 line sets: start > end is reported as bad, not merged', () => {
  const p = parse('1-2,9-3');
  assert.deepEqual(p.bad, [[9, 3]]);
  assert.equal(format(p.set), '1-2');
  assert.equal(parse('a').malformed, true);
});

test('line set algebra', () => {
  const a = parse('1-10').set;
  const b = parse('3-4,8').set;
  assert.equal(format(diff(a, b)), '1-2,5-7,9-10');
  assert.equal(format(intersect(a, b)), '3-4,8');
  assert.equal(format(union(b, parse('5-7').set)), '3-8');
  assert.equal(size(a), 10);
  assert.equal(format(diff(b, a)), '');
});

test('exclusive lines: lines held by exactly one owner', () => {
  const [x, y, z] = exclusiveLines([mapFrom({ s: '1-5' }), mapFrom({ s: '4-8', t: '1' }), mapFrom({ s: '8' })]);
  assert.deepEqual(mapToObject(x), { s: '1-3' });
  assert.deepEqual(mapToObject(y), { s: '6-7', t: '1' });
  assert.deepEqual(mapToObject(z), {});
});

test('tokens split at non-alphanumerics and lowercase-to-uppercase boundaries', () => {
  assert.deepEqual(tokens('src/authService/signIn.ts'), ['src', 'auth', 'service', 'sign', 'in', 'ts']);
  assert.deepEqual(tokens('HTTPServer'), ['httpserver']); // no lowercase-to-uppercase boundary
  assert.deepEqual(tokens('v2Api'), ['v2api']); // digit-to-uppercase is not a boundary
  assert.deepEqual(tokens('--a__b--'), ['a', 'b']);
});

test('words match consecutive tokens, the last as a prefix', () => {
  const tk = tokens('db/migrations/run.ts');
  assert.equal(wordMatches('migrat', tk), true);
  assert.equal(wordMatches('sign-in', tokens('tests/signInFlow.test.ts')), true);
  assert.equal(wordMatches('sign-in', tokens('tests/sign/x/in.ts')), false); // not consecutive
  assert.equal(wordMatches('public-api', tokens('src/public_apis.ts')), true);
  assert.equal(wordMatches('public-api', tokens('src/publicity/api.ts')), false); // only the last token is a prefix
  assert.equal(wordMatches('auth', tokens('src/oauth.ts')), false); // a word starts at a token
  assert.equal(wordMatches('-', tokens('anything')), true); // a word with no tokens matches vacuously
});

test('globs', () => {
  assert.equal(globMatches('src/**/auth.ts', 'src/auth.ts'), true); // zero segments
  assert.equal(globMatches('src/**/auth.ts', 'src/a/b/auth.ts'), true);
  assert.equal(globMatches('**/auth.ts', 'auth.ts'), true);
  assert.equal(globMatches('src/**', 'src/a/b.ts'), true);
  assert.equal(globMatches('src/**', 'srcx/a.ts'), false);
  assert.equal(globMatches('**', 'a/b/c'), true);
  assert.equal(globMatches('src/*.ts', 'src/a.ts'), true);
  assert.equal(globMatches('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(globMatches('src/?.ts', 'src/a.ts'), true);
  assert.equal(globMatches('src/?.ts', 'src/ab.ts'), false);
  assert.equal(globMatches('src/a.ts', 'src/a.ts.bak'), false); // whole path
  assert.equal(globMatches('src/[ab].ts', 'src/[ab].ts'), true); // every other character is literal
  assert.equal(globMatches('src/[ab].ts', 'src/a.ts'), false);
  assert.equal(globMatches('a/**/**/b', 'a/b'), true);
  // `**` inside a segment: strict reads it as `*`, loose (critical globs) lets it cross `/`.
  assert.equal(globMatches('src/**.ts', 'src/x/y.ts', false), false);
  assert.equal(globMatches('src/**.ts', 'src/x/y.ts', true), true);
});

test('code point order sorts astral characters after U+FFFF', () => {
  const s = ['\u{1F600}', '�', 'b', 'a'].sort(cmp);
  assert.deepEqual(s, ['a', 'b', '�', '\u{1F600}']);
});

test('R2 ratios floor to two decimals and are null over 0', () => {
  assert.equal(pct(1, 3), 33.33);
  assert.equal(pct(2, 3), 66.66); // never rounds up
  assert.equal(pct(3, 3), 100);
  assert.equal(pct(0, 0), null);
  assert.equal(pct(1, 8), 12.5);
});

test('thresholds compare exactly as decimals', () => {
  assert.deepEqual(decimal(0.8), [8n, 10n]);
  assert.deepEqual(decimal(1e-7), [1n, 10000000n]);
  assert.equal(ratioAtLeast(4, 5, 0.8), true);
  assert.equal(ratioAtLeast(9, 10, 0.9), true);
  assert.equal(ratioAtLeast(89, 100, 0.9), false);
  assert.equal(ratioAtLeast(0, 0, 0), true);
  assert.equal(ratioAtLeast(0, 0, 0.1), false);
});
