// Static assertion checks for JavaScript and TypeScript tests (node:test, Vitest,
// Jest); the same rules as the Rust and Python checks (test-quality audit,
// phase 3).
//
// `no-assertion` is reported only when certain: the body has no assert/expect,
// no `throw`, no `t.plan`, no check-named call, no same-file helper that checks,
// no call into a test-helper module, and no nested test. Otherwise nothing is
// reported.
// `tautology`: `assert(true)`, `assert.ok(true)`, `assert.equal(x, x)`,
// `expect(x).toBe(x)`, `expect(true).toBeTruthy()` and similar.

const CHECK_CALL = /^(?:assert|check|verify|expect|ensure|must|validate|should|fail)/i;
const NESTED = new Set(['test', 'it', 'describe', 'suite', 'context']);
const EQUALITY = /^(?:equal|strictEqual|deepEqual|deepStrictEqual)$/;
const EXPECT_EQUALITY = /^(?:toBe|toEqual|toStrictEqual)$/;
const HELPER_PATH = /(?:^|[/\\])(?:[^/\\]*(?:test|spec|helper|fixture|support|util|harness|common|setup)[^/\\]*)(?:[/\\]|\.[cm]?[jt]sx?$|$)/i;

/** Names imported from relative modules that look like test helpers. */
export function helperImports(toks) {
  const names = new Set();
  const v = (k) => toks[k]?.value;
  for (let k = 0; k < toks.length; k++) {
    if (v(k) === 'import') {
      let q = k + 1; const found = [];
      while (q < toks.length && v(q) !== 'from' && v(q) !== ';' && toks[q].type !== 'string') {
        if (toks[q].type === 'name' && !['as', 'type', 'default'].includes(v(q)) && v(q + 1) !== 'as') found.push(v(q));
        q++;
      }
      const source = v(q) === 'from' ? v(q + 1) : null;
      // A relative import that is not the code under test (outside src/ and lib/) may be a checking helper.
      if (source && /^['"`]\./.test(source) && (HELPER_PATH.test(source.slice(1, -1)) || !/(?:^|\/)(?:src|lib)\//.test(source.slice(1, -1)))) for (const n of found) names.add(n);
    } else if (v(k) === 'require' && v(k + 1) === '(' && toks[k + 2]?.type === 'string') {
      const source = v(k + 2);
      if (!/^['"`]\./.test(source) || (!HELPER_PATH.test(source.slice(1, -1)) && /(?:^|\/)(?:src|lib)\//.test(source.slice(1, -1)))) continue;
      // const { a, b } = require('./helpers') or const helper = require('./helpers')
      let q = k - 1;
      if (v(q) === '=') q--;
      if (v(q) === '}') { while (q > 0 && v(q) !== '{') { if (toks[q].type === 'name') names.add(v(q)); q--; } }
      else if (toks[q]?.type === 'name') names.add(v(q));
    }
  }
  return names;
}

/** Function bodies by name: `function name(...) {}` and `const name = (...) => {}` / `= function`. */
export function localFunctions(toks, pairs) {
  const bodies = new Map();
  const v = (k) => toks[k]?.value;
  const add = (name, open) => {
    if (!pairs.has(open)) return;
    if (!bodies.has(name)) bodies.set(name, []);
    bodies.get(name).push([open, pairs.get(open)]);
  };
  for (let k = 0; k < toks.length; k++) {
    if (v(k) === 'function' && toks[k + 1]?.type === 'name' && v(k + 2) === '(' && pairs.has(k + 2) && v(pairs.get(k + 2) + 1) === '{') {
      add(v(k + 1), pairs.get(k + 2) + 1);
    } else if (['const', 'let', 'var'].includes(v(k)) && toks[k + 1]?.type === 'name' && v(k + 2) === '=') {
      let q = k + 3;
      if (v(q) === 'async') q++;
      if (v(q) === 'function') { q++; if (toks[q]?.type === 'name') q++; }
      if (v(q) === '(' && pairs.has(q)) q = pairs.get(q) + 1;
      else if (toks[q]?.type === 'name' && v(q + 1) === '=>') q++;
      if (v(q) === '=>') q++;
      if (v(q) === '{') add(v(k + 1), q);
    }
  }
  return bodies;
}

const textOf = (src, toks, a, b) => (a < b ? src.slice(toks[a].start, toks[b - 1].end).replace(/\s+/g, ' ').trim() : '');

function argsOf(toks, pairs, open) {
  const close = pairs.get(open); const out = []; let start = open + 1;
  for (let q = open + 1; q < close; q++) {
    if (pairs.has(q) && pairs.get(q) > q) { q = pairs.get(q); continue; }
    if (toks[q].value === ',') { out.push([start, q]); start = q + 1; }
  }
  if (start < close) out.push([start, close]);
  return out;
}

/** Tautology lines in [from, to). */
export function tautologyLines(src, toks, pairs, from, to) {
  const lines = []; const v = (k) => toks[k]?.value;
  const constantTrue = (a, b) => b - a === 1 && /^(?:true|1)$/.test(v(a));
  // Calls can differ between evaluations (getInstance(), next()): only call-free sides are certain.
  const callFree = (a, b) => !toks.slice(a, b).some((t) => t.value === '(');
  for (let k = from; k < to; k++) {
    if (toks[k].type !== 'name') continue;
    // assert(x) / assert.ok(x) / assert.equal(a, b) ...
    if (v(k) === 'assert' && v(k - 1) !== '.') {
      const member = v(k + 1) === '.' ? v(k + 2) : null;
      const open = member ? k + 3 : k + 1;
      if (v(open) !== '(' || !pairs.has(open)) continue;
      const args = argsOf(toks, pairs, open);
      if ((!member || member === 'ok') && args[0] && constantTrue(...args[0])) lines.push(toks[k].line);
      else if (member && EQUALITY.test(member) && args.length >= 2 && callFree(...args[0]) && textOf(src, toks, ...args[0]) === textOf(src, toks, ...args[1])) lines.push(toks[k].line);
    }
    // expect(a).toBe(b) ...
    if (v(k) === 'expect' && v(k - 1) !== '.' && v(k + 1) === '(' && pairs.has(k + 1)) {
      const close = pairs.get(k + 1);
      const subject = argsOf(toks, pairs, k + 1)[0];
      if (!subject || v(close + 1) !== '.' || toks[close + 2]?.type !== 'name') continue;
      const matcher = v(close + 2);
      if (matcher === 'toBeTruthy' && constantTrue(...subject)) lines.push(toks[k].line);
      if (EXPECT_EQUALITY.test(matcher) && v(close + 3) === '(' && pairs.has(close + 3)) {
        const expected = argsOf(toks, pairs, close + 3)[0];
        if (expected && callFree(...subject) && textOf(src, toks, ...subject) === textOf(src, toks, ...expected)) lines.push(toks[k].line);
      }
    }
  }
  return lines;
}

/** Does [from, to) check anything? → true, false or 'unknown'. */
export function checksJs(toks, pairs, from, to, ctx, seen = new Set(), depth = 0) {
  let unknown = false; const v = (k) => toks[k]?.value;
  for (let k = from; k < to; k++) {
    const t = toks[k];
    if (t.type !== 'name') continue;
    if (t.value === 'throw' || t.value === 'assert' || t.value === 'expect' || t.value === 'should') return true;
    if (t.value === 'plan' && v(k - 1) === '.') return true;
    if (v(k + 1) !== '(') continue;
    if (v(k - 1) === '.') { if (/^(?:rejects|throws|doesNotThrow|doesNotReject)$/.test(t.value)) return true; if (NESTED.has(t.value)) unknown = true; continue; }
    if (NESTED.has(t.value)) { unknown = true; continue; }
    if (CHECK_CALL.test(t.value)) return true;
    if (ctx.helpers.has(t.value)) { unknown = true; continue; }
    const helper = ctx.bodies.get(t.value);
    if (!helper || seen.has(t.value)) continue;
    if (depth >= 4) { unknown = true; continue; }
    seen.add(t.value);
    for (const [open, close] of helper) {
      const inner = checksJs(toks, pairs, open + 1, close, ctx, seen, depth + 1);
      if (inner === true) return true;
      if (inner === 'unknown') unknown = true;
    }
  }
  return unknown ? 'unknown' : false;
}

/** Findings for one test definition body [from, to): [{ kind, line }]. */
export function weakFindings(src, toks, pairs, from, to, line, ctx) {
  const findings = tautologyLines(src, toks, pairs, from, to).map((at) => ({ kind: 'tautology', line: at }));
  // A body that is only a title (test.todo('x')) or empty has nothing to judge.
  if (to - from > 2 && checksJs(toks, pairs, from, to, ctx) === false) findings.unshift({ kind: 'no-assertion', line });
  return findings;
}
