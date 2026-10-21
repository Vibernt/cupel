#!/usr/bin/env node
// S6 static brittleness detector for node:test files. Standard library only; uses S3's lexer.
//
// Usage: node plans/spikes/s6/detect-js.mjs <suite-root> [tests-dir=tests] [--strict] > brittle-js.json
//
// Output: { tests: [{ file, name, pattern, line, endLine, shape, flags: [{ kind, line, evidence }] }] }
// `shape` is the test body's tokens with literals masked (strings S, numbers N, regexes R), for body similarity.
// `name` is the literal test name; `pattern` is a regex source when the name is a template (`${…}` → `.*`).
// Nested names are joined with ' > ' (describe/suite, as node:test's fullName does).
//
// Patterns (a flag needs a text source AND an assertion on text in the same test):
//   source-text   the test reads a code file (.mjs .js .ts .html .py .sh, or a path under src/ public/ scripts/
//                 actions/ sdk/ cli/ router/ runner/ daemon/) as text, directly, through a top-level variable that
//                 holds such a read, or through a helper whose body does such a read; and it asserts with
//                 match/doesNotMatch/includes/test/indexOf/startsWith/endsWith/equal on it
//   doc-wording   the same for documentation (.md, .txt, docs/, README, CHANGELOG)
//   css-class     a CSS file read as text and asserted on, or a string or regex in the test that pins class
//                 names (`class=`, `className`, `classList`, or a CSS rule `\.name\s*{`)
//   file-snapshot an equality assertion (equal/strictEqual/deepEqual/deepStrictEqual) whose arguments contain a
//                 whole-file read (or a variable holding one), or a snapshot API (snapshot(, toMatchSnapshot)
// Reads under fixtures/ that only feed the code under test are not flagged; JSON reads are data, not text.
//
// --strict (the tuned detector, v1) fixes the false positives found in the S6 hand-check:
//   - only module-level reads and declarations taint a name (a `const input = readFileSync(...)` inside a helper
//     function no longer taints every `input` in the file)
//   - any path naming a fixture is an input (not a pin), unless it names an expected/golden/snapshot file
//   - file-snapshot needs the read (or a name holding one) as a direct argument of the equality assertion, not
//     nested in a call such as parse(fixture(...)) or sha256(file), and never a read of unknown kind
//   - source-text and doc-wording need an assertion with a literal: match/doesNotMatch with a regex or string,
//     includes/indexOf/startsWith/endsWith with a string, or /re/.test(...); computed checks such as
//     anchors.includes(guide.anchor) are integrity checks, not pins
//   - css-class strings count only inside an assertion call, not in input data

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize, matchBrackets } from '../s3/lexer.mjs';

const KIND_OF_PATH = (text, strict) => {
  if (/\.json\b/.test(text)) return null;
  if (strict && /fixture/i.test(text)) return /expected|golden|snap/i.test(text) ? 'golden' : 'fixture';
  if (/\.css\b/.test(text)) return 'css-class';
  if (/\.(md|txt)\b|docs\/|README|CHANGELOG|GUIDE/.test(text)) return 'doc-wording';
  if (/fixtures\//.test(text)) return 'fixture';
  if (/\.(mjs|cjs|js|ts|tsx|jsx|html|py|sh|ya?ml|toml)\b|(^|[^\w])(src|public|scripts|actions|sdk|cli|router|runner|daemon|docker|infra)\//.test(text)) return 'source-text';
  return 'unknown';
};
const READERS = new Set(['readFileSync', 'readFile']);
const TEXT_ASSERT = /^(match|doesNotMatch|includes|test|indexOf|startsWith|endsWith|equal|strictEqual|notEqual|ok)$/;
const EQ_ASSERT = /^(equal|strictEqual|deepEqual|deepStrictEqual)$/;

export function detectFile(src, file, opts = {}) {
  const strict = !!opts.strict;
  const toks = tokenize(src);
  const pairs = matchBrackets(toks);
  // Brace depth of each token (template `${` excluded): 0 is module level.
  const depthAt = new Int32Array(toks.length);
  for (let k = 0, d = 0; k < toks.length; k++) {
    if (toks[k].type === 'punct' && toks[k].value === '}') d = Math.max(0, d - 1);
    depthAt[k] = d;
    if (toks[k].type === 'punct' && toks[k].value === '{') d++;
  }
  // Assertion call ranges: assert.x( … ) and assert( … ).
  const assertRanges = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'name' || toks[k].value !== 'assert') continue;
    const open = toks[k + 1]?.value === '(' ? k + 1 : (toks[k + 1]?.value === '.' && toks[k + 3]?.value === '(' ? k + 3 : -1);
    if (open > 0 && pairs.has(open)) assertRanges.push([open, pairs.get(open)]);
  }
  const inAssert = (k) => assertRanges.some(([a, b]) => k > a && k < b);
  const text = (a, b) => src.slice(toks[a].start, toks[b].end);
  // 1. Helper functions whose body reads a text file: `const read = p => readFile(...)`, `function read(p) {…}`.
  const helpers = new Map(); // name -> kind
  // 2. Text reads: token index of the reader name -> { kind, end }
  const reads = [];
  const readKindAt = (k) => {
    const t = toks[k];
    if (t.type !== 'name' || toks[k + 1]?.value !== '(' || toks[k - 1]?.value === '.' && !READERS.has(t.value)) return null;
    if (!READERS.has(t.value) && !helpers.has(t.value)) return null;
    if (toks[k - 1]?.value === 'function') return null;
    const close = pairs.get(k + 1);
    if (close === undefined) return null;
    const argText = text(k + 1, close);
    let kind = KIND_OF_PATH(argText, strict);
    if (!READERS.has(t.value)) kind = (kind === 'unknown' || kind === null) ? helpers.get(t.value) : kind;
    return { kind, end: close, argText };
  };
  // Find helpers first (two passes, so helpers defined after use still count).
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      let name = null, bodyStart = null;
      if (t.type === 'name' && (t.value === 'const' || t.value === 'let') && toks[k + 1]?.type === 'name' && toks[k + 2]?.value === '=') {
        // const name = (args) => body | async p => body | function (…) {…}
        let j = k + 3;
        if (toks[j]?.value === 'async') j++;
        if (toks[j]?.value === '(' && toks[pairs.get(j) + 1]?.value === '=>') { name = toks[k + 1].value; bodyStart = pairs.get(j) + 2; }
        else if (toks[j]?.type === 'name' && toks[j + 1]?.value === '=>') { name = toks[k + 1].value; bodyStart = j + 2; }
        else if (toks[j]?.value === 'function') { name = toks[k + 1].value; bodyStart = j; }
      } else if (t.value === 'function' && toks[k + 1]?.type === 'name') { name = toks[k + 1].value; bodyStart = k + 2; }
      if (!name) continue;
      if (strict && depthAt[k] > 0) continue;
      // body end: matching bracket of the first ( or {, or to the end of the statement
      let end = bodyStart;
      if (toks[end]?.value === '(' || toks[end]?.value === '{') end = pairs.get(end) ?? end;
      else if (toks[end]?.value === 'function') { let q = end; while (q < toks.length && toks[q].value !== '{') q++; end = pairs.get(q) ?? q; }
      else { let q = end; while (q < toks.length && toks[q].value !== ';' && toks[q].value !== ',') { if (pairs.has(q) && pairs.get(q) > q) q = pairs.get(q); q++; } end = q; }
      if (toks[end + 1]?.value === '.' || toks[end + 1]?.value === '(') { let q = end + 1; while (q < toks.length && toks[q].value !== ';') { if (pairs.has(q) && pairs.get(q) > q) q = pairs.get(q); q++; } end = q; }
      for (let q = bodyStart; q <= end && q < toks.length; q++) {
        const r = readKindAt(q);
        if (r && r.kind && r.kind !== 'fixture') { if (!helpers.has(name)) helpers.set(name, r.kind === 'unknown' ? 'unknown' : r.kind); }
      }
    }
  }
  for (let k = 0; k < toks.length; k++) {
    const r = readKindAt(k);
    if (r) reads.push({ k, ...r });
    // A helper passed by reference (`paths.map(read)`) reads too.
    else if (toks[k].type === 'name' && helpers.has(toks[k].value) && toks[k - 1]?.value !== '.' && (toks[k + 1]?.value === ')' || toks[k + 1]?.value === ',') && (toks[k - 1]?.value === '(' || toks[k - 1]?.value === ','))
      reads.push({ k, kind: helpers.get(toks[k].value), end: k, argText: toks[k].value });
  }
  // 3. Top-level variables that hold a read: the declaration pattern before the read in the same statement.
  const tainted = new Map(); // var -> kind
  const testRanges = [];
  // Find test blocks (with describe/suite nesting).
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    while (stack.length && k > stack.at(-1).end) stack.pop();
    const t = toks[k];
    if (t.type !== 'name' || toks[k + 1]?.value !== '(' || (toks[k - 1]?.value === '.' && toks[k - 2]?.value !== 't')) continue;
    const isTest = t.value === 'test' || t.value === 'it' || (t.value === 'test' && toks[k - 2]?.value === 't');
    const isGroup = t.value === 'describe' || t.value === 'suite';
    if (!isTest && !isGroup) continue;
    if (toks[k - 1]?.value === 'function' || toks[k - 1]?.value === 'import') continue;
    const close = pairs.get(k + 1);
    if (close === undefined) continue;
    const a = toks[k + 2];
    if (!a || (a.type !== 'string' && a.type !== 'template')) continue;
    let name, pattern = null;
    if (a.type === 'string') name = JSON.parse(a.value[0] === "'" ? `"${a.value.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : a.value);
    else {
      // template: collect pieces until the closing backtick
      let q = k + 2, raw = '';
      while (q < close) { raw += toks[q].value; if (toks[q].type === 'template' && toks[q].value.endsWith('`')) break; q = toks[q].value.endsWith('${') ? (pairs.get(q) ?? q) : q + 1; if (toks[q]?.type === 'template') continue; }
      raw = src.slice(a.start, toks[q].end);
      name = raw.slice(1, -1);
      if (/\$\{/.test(name)) pattern = name.split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    }
    const prefix = stack.map((s) => s.name).join(' > ');
    const full = prefix ? `${prefix} > ${name}` : name;
    if (isGroup) { stack.push({ name, end: close }); continue; }
    testRanges.push({ name: full, pattern: pattern ? (prefix ? `${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} > ${pattern}` : pattern) : null, start: k, end: close });
    k = close; // tests do not nest here (t.test subtests are rare in Assay)
  }
  const inTest = (k) => testRanges.some((r) => k >= r.start && k <= r.end);
  for (const r of reads) {
    if (inTest(r.k) || !r.kind || r.kind === 'fixture') continue;
    if (strict && depthAt[r.k] > 0) continue;
    // walk back to the declaration keyword of this statement
    let q = r.k - 1, depth = 0;
    while (q >= 0) {
      const v = toks[q].value;
      if (pairs.has(q) && pairs.get(q) < q) { q = pairs.get(q) - 1; continue; }
      if (v === ';' || (v === '}' && depth === 0) || v === '{') break;
      if (toks[q].type === 'name' && (v === 'const' || v === 'let' || v === 'var')) {
        const eq = toks.findIndex((tk, i) => i > q && tk.value === '=');
        for (let i = q + 1; i < eq; i++) if (toks[i].type === 'name' && toks[i - 1]?.value !== ':') tainted.set(toks[i].value, r.kind);
        break;
      }
      q--;
    }
  }
  // Second-order taint: `const lines = account.split('\n')`, `const all = data + account`.
  for (let k = 0; k < toks.length; k++) {
    if (inTest(k)) continue;
    if (strict && depthAt[k] > 0) continue;
    const t = toks[k];
    if (t.type === 'name' && (t.value === 'const' || t.value === 'let') && toks[k + 1]?.type === 'name' && toks[k + 2]?.value === '=') {
      let q = k + 3;
      while (q < toks.length && toks[q].value !== ';' && !(toks[q].type === 'name' && ['const', 'let', 'test'].includes(toks[q].value))) {
        if (toks[q].type === 'name' && tainted.has(toks[q].value) && toks[q - 1]?.value !== '.') { tainted.set(toks[k + 1].value, tainted.get(toks[q].value)); break; }
        q++;
      }
    }
  }
  const out = [];
  for (const r of testRanges) {
    const flags = [];
    const line = (k) => toks[k].line;
    let textAssert = false;
    let sourceKinds = new Map(); // kind -> first line
    for (let k = r.start; k <= r.end; k++) {
      const t = toks[k];
      if (t.type === 'name' && toks[k - 1]?.value === '.' && TEXT_ASSERT.test(t.value) && toks[k + 1]?.value === '(') {
        if (!strict) textAssert = true;
        else {
          const close = pairs.get(k + 1) ?? k + 1;
          const lit = (q) => toks[q] && (toks[q].type === 'string' || toks[q].type === 'regex' || (toks[q].type === 'template' && !toks[q].value.endsWith('${')));
          if (/^(match|doesNotMatch)$/.test(t.value)) {
            // a regex or string literal (or new RegExp(...)) after the first argument
            for (let q = k + 2; q < close; q++) {
              if (toks[q].value === ',') { if (lit(q + 1) || toks[q + 1]?.value === 'new') textAssert = true; break; }
              if (pairs.has(q) && pairs.get(q) > q) q = pairs.get(q);
            }
          } else if (/^(includes|indexOf|startsWith|endsWith)$/.test(t.value)) { if (lit(k + 2)) textAssert = true; }
          else if (t.value === 'test' && toks[k - 2]?.type === 'regex') textAssert = true;
        }
      }
      if (t.type === 'name' && tainted.has(t.value) && toks[k - 1]?.value !== '.' && toks[k + 1]?.value !== ':') {
        const kind = tainted.get(t.value);
        if (!sourceKinds.has(kind)) sourceKinds.set(kind, [line(k), t.value]);
      }
      const rd = reads.find((x) => x.k === k);
      if (rd && rd.kind && rd.kind !== 'fixture' && !sourceKinds.has(rd.kind)) sourceKinds.set(rd.kind, [line(k), rd.argText.slice(0, 60)]);
      // css-class strings and regexes
      if ((t.type === 'string' || t.type === 'template' || t.type === 'regex') &&
        (/class(Name)?\s*=|classList|class:\s*['"]|\bclass\\?=/.test(t.value) || (t.type === 'regex' && /\\\.[a-z][\w-]*(\\s\*)?\s*\\?\{/.test(t.value)))) {
        if (!flags.some((f) => f.kind === 'css-class') && (!strict || inAssert(k))) flags.push({ kind: 'css-class', line: line(k), evidence: t.value.slice(0, 60) });
      }
      if (t.type === 'name' && /^(snapshot|toMatchSnapshot|fileSnapshot|toMatchFileSnapshot)$/.test(t.value) && toks[k + 1]?.value === '(') {
        if (!flags.some((f) => f.kind === 'file-snapshot')) flags.push({ kind: 'file-snapshot', line: line(k), evidence: t.value });
      }
      // equality assertion holding a whole-file read
      if (t.type === 'name' && EQ_ASSERT.test(t.value) && toks[k - 1]?.value === '.' && toks[k + 1]?.value === '(') {
        const close = pairs.get(k + 1);
        for (let q = k + 2; q < close; q++) {
          const rr = reads.find((x) => x.k === q);
          const tv = toks[q].type === 'name' && tainted.has(toks[q].value) && toks[q - 1]?.value !== '.' && toks[q + 1]?.value !== '.' && toks[q + 1]?.value !== '[' && (!strict || toks[q + 1]?.value !== '(');
          const okKind = (kd) => !strict || ['source-text', 'doc-wording', 'css-class', 'golden'].includes(kd);
          if ((rr && rr.kind !== null && okKind(rr.kind)) || (tv && okKind(tainted.get(toks[q].value)))) {
            if (!flags.some((f) => f.kind === 'file-snapshot')) flags.push({ kind: 'file-snapshot', line: line(k), evidence: text(k, Math.min(close, k + 12)).slice(0, 80) });
            break;
          }
          // strict: only direct arguments; skip nested calls and brackets
          if (strict && rr) q = rr.end;
          else if (strict && pairs.has(q) && pairs.get(q) > q && toks[q].type === 'punct') q = pairs.get(q);
        }
      }
    }
    if (textAssert) {
      for (const [kind, [ln, ev]] of sourceKinds) {
        if (kind === 'unknown' || kind === 'golden') continue;
        if (!flags.some((f) => f.kind === kind)) flags.push({ kind, line: ln, evidence: ev });
      }
    }
    const shape = [];
    for (let k = r.start + 3; k <= r.end; k++) {
      const t = toks[k];
      shape.push(t.type === 'string' || t.type === 'template' ? 'S' : t.type === 'num' ? 'N' : t.type === 'regex' ? 'R' : t.value);
    }
    out.push({ file, name: r.name, pattern: r.pattern, line: line(r.start), endLine: line(r.end), shape: shape.join(' '), flags });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const [root, dir = 'tests'] = argv.filter((a) => a !== '--strict');
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.test.mjs')).sort();
  const tests = [];
  const errors = [];
  for (const f of files) {
    try { tests.push(...detectFile(readFileSync(join(root, dir, f), 'utf8'), `${dir}/${f}`, { strict })); } catch (e) { errors.push({ file: f, error: String(e.message) }); }
  }
  const counts = {};
  for (const t of tests) for (const fl of t.flags) counts[fl.kind] = (counts[fl.kind] ?? 0) + 1;
  console.log(JSON.stringify({ strict, files: files.length, tests: tests.length, flagged: tests.filter((t) => t.flags.length).length, counts, errors, tests }));
}
