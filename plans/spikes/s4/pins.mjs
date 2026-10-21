#!/usr/bin/env node
// S4: a static brittleness scan of node:test files (the "Brittleness" signal in plans/ARCHITECTURE.md).
//
// Usage:
//   node plans/spikes/s4/pins.mjs --root /abs/suite [--json out.json] tests/a.test.mjs tests/b.test.mjs
//
// Splits each file into its top-level tests (`test(` at the start of a line) and counts, per test:
//   source   readFileSync/readFile of a source file (src/, public/ outside public/generated/, docs/, *.md, *.css):
//            assertions on source text, which in-memory mutants never reach (S3)
//   class    a querySelector/querySelectorAll/closest selector with a CSS class (`.name`): a styling class pin
//   copy     a fixed prose literal in an assertion: a string or regex literal of 4 or more words passed to
//            assert.equal/deepEqual/match/doesNotMatch, or a `textContent.trim()` compared with a fixed string
//   style    a rule about copy rather than behaviour: a regex of dash characters, or a text length threshold
// Heuristic: it reads text, not an AST. It prints one line per test and file totals, and writes JSON with --json.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args } from '../s2/exec.mjs';

const opt = args(process.argv.slice(2));
if (!opt.root || !opt._.length) { console.error('usage: node pins.mjs --root <suite> [--json f] <test files>'); process.exit(2); }

const SELECTOR_CALL = /\.(?:querySelectorAll|querySelector|closest)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const CLASS_IN_SELECTOR = /(^|[\s>+~,(])[a-z0-9-]*\.[a-zA-Z_][\w-]*/;
const ASSERT_CALL = /assert\.(equal|deepEqual|match|doesNotMatch|notEqual|ok)\(/g;
const words = (lit) => lit.replace(/\\[sSdDwWbB][*+?]?|\\.|[\^$()[\]{}|*+?]/g, ' ').trim().split(/\s+/).filter((w) => /[a-zA-Z]{2,}/.test(w)).length;

function literalsIn(text) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1).)*)\1|\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+)\/[gimsuy]*/g;
  let m;
  while ((m = re.exec(text))) out.push(m[2] ?? m[3]);
  return out;
}

/** The argument text of a call that starts at `open` (the index of its '('), balancing brackets and skipping strings. */
function callArgs(src, open) {
  let depth = 0, i = open, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (!depth) break; }
  }
  return src.slice(open + 1, i);
}

/** Splits call arguments at top-level commas (outside brackets, strings and regex literals). */
function topLevelArgs(text) {
  const out = [];
  let depth = 0, quote = null, start = 0, regex = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (regex) { if (c === '\\') i++; else if (c === '/') regex = false; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && /[,(=:[!&|?{};]\s*$|^\s*$/.test(text.slice(start, i))) regex = true;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && !depth) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function scan(src) {
  const counts = { source: 0, class: 0, copy: 0, style: 0 };
  const examples = [];
  for (const m of src.matchAll(/readFile(?:Sync)?\(\s*new URL\(\s*(['"`])([^'"`]+)\1|readFile(?:Sync)?\(\s*(['"`])([^'"`]+)\3/g)) {
    const p = m[2] ?? m[4];
    if (/(^|\/)(src|docs)\//.test(p) || (/(^|\/)public\//.test(p) && !/public\/generated\//.test(p)) || /\.(md|css)$/.test(p)) { counts.source++; examples.push(`source: ${p}`); }
  }
  for (const m of src.matchAll(SELECTOR_CALL)) if (CLASS_IN_SELECTOR.test(m[2])) { counts.class++; examples.push(`class: ${m[2]}`); }
  for (const m of src.matchAll(ASSERT_CALL)) {
    const a = callArgs(src, m.index + m[0].length - 1);
    if (/\/\[[–—]+\]\/|\\u201[34]/.test(a) || /\.length\s*>\s*\d{2}/.test(a)) { counts.style++; examples.push(`style: ${a.slice(0, 80)}`); continue; }
    if (!['equal', 'deepEqual', 'match', 'doesNotMatch', 'notEqual'].includes(m[1])) continue;
    // Only the expected value (the second argument) can pin copy; the first is the value under test and may hold inputs.
    const expected = topLevelArgs(a)[1] ?? '';
    const prose = literalsIn(expected).filter((l) => words(l) >= 4);
    if (prose.length) { counts.copy++; examples.push(`copy: ${prose[0].slice(0, 70)}`); }
  }
  return { counts, examples };
}

const report = { files: {} };
const total = { tests: 0, source: 0, class: 0, copy: 0, style: 0, testsWithPins: 0 };
for (const file of opt._) {
  const src = readFileSync(join(opt.root, file), 'utf8');
  const starts = [...src.matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => ({ at: m.index, name: m[2] }));
  const tests = starts.map((t, i) => {
    const body = src.slice(t.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
    return { name: t.name, ...scan(body) };
  });
  report.files[file] = tests;
  for (const t of tests) {
    total.tests++;
    for (const k of ['source', 'class', 'copy', 'style']) total[k] += t.counts[k];
    if (t.counts.source + t.counts.class + t.counts.copy + t.counts.style) total.testsWithPins++;
    console.log(`${String(t.counts.source).padStart(2)} ${String(t.counts.class).padStart(2)} ${String(t.counts.copy).padStart(2)} ${String(t.counts.style).padStart(2)}  ${file.replace(/^tests\//, '')} :: ${t.name.slice(0, 90)}`);
  }
}
report.total = total;
console.log(`total: ${total.tests} tests, ${total.testsWithPins} with a pin; source ${total.source}, class ${total.class}, copy ${total.copy}, style ${total.style}`);
if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 1));
