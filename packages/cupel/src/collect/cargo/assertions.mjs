// Static assertion checks for Rust tests (plan: test-quality audit, phase 3).
//
// `no-assertion`: the test body checks nothing. It is reported only when that is
// certain: no assertion macro, no `unwrap`/`expect` family call, no `?`, no
// `#[should_panic]`, no Result return, no call to a check-named function, and no
// same-file helper that checks. A custom macro or a call into a test-helper
// module (`common::`, `helpers::`, ...) makes the answer unknown, and nothing is
// reported.
//
// `tautology`: an assertion that cannot fail: `assert!(true)`, `assert_eq!(x, x)`,
// `assert!(x == x)` with the same text on both sides.

const ASSERT_MACRO = /^(?:debug_)?assert(?:_eq|_ne|_matches)?$|^(?:panic|unreachable|todo|unimplemented)$/;
const QUIET_MACRO = new Set(['println', 'eprintln', 'print', 'eprint', 'format', 'format_args', 'vec', 'write', 'writeln', 'dbg',
  'concat', 'stringify', 'include_str', 'include_bytes', 'env', 'option_env', 'file', 'line', 'column', 'module_path', 'matches', 'cfg']);
const CHECKING_METHOD = /^(?:unwrap|expect|unwrap_err|expect_err|unwrap_none|expect_none|compile_fail|pass|run_pass|run_fail)$|^(?:assert|check|verify|expect|ensure|must|validate)/;
const CHECK_CALL = /^(?:assert|check|verify|expect|ensure|must|validate)/i;
const HELPER_MODULE = new Set(['common', 'helpers', 'helper', 'support', 'util', 'utils', 'fixtures', 'fixture', 'testing', 'harness', 'testutil', 'test_util', 'test_utils']);

const ident = (t) => !!t && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value);

/** Matching close index for an open bracket token, or -1. */
function closing(tokens, open) {
  const pair = { '(': ')', '[': ']', '{': '}' }[tokens[open]?.value];
  if (!pair) return -1;
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].value === tokens[open].value) depth++;
    else if (tokens[i].value === pair && --depth === 0) return i;
  }
  return -1;
}

/** Every `fn name(...) ... { body }` in a file: name → [bodyOpen, bodyClose] token ranges. */
export function functionBodies(tokens) {
  const bodies = new Map();
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].value !== 'fn' || !ident(tokens[i + 1])) continue;
    let j = i + 2;
    while (j < tokens.length && tokens[j].value !== '{' && tokens[j].value !== ';') j++;
    if (tokens[j]?.value !== '{') continue;
    const end = closing(tokens, j);
    if (end < 0) continue;
    if (!bodies.has(tokens[i + 1].value)) bodies.set(tokens[i + 1].value, []);
    bodies.get(tokens[i + 1].value).push([j, end]);
  }
  return bodies;
}

/** Splits [from, to) at top-level commas into token ranges. */
function argumentsOf(tokens, from, to) {
  const out = []; let start = from; let depth = 0;
  for (let i = from; i < to; i++) {
    const v = tokens[i].value;
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') depth--;
    else if (v === ',' && depth === 0) { out.push([start, i]); start = i + 1; }
  }
  if (start < to) out.push([start, to]);
  return out;
}

const text = (tokens, [a, b]) => tokens.slice(a, b).map((t) => t.raw).join(' ');

/** Tautology lines in [from, to). */
export function tautologies(tokens, from, to) {
  const lines = [];
  for (let i = from; i < to - 2; i++) {
    const name = tokens[i].value;
    if (!/^(?:debug_)?assert(?:_eq)?$/.test(name) || tokens[i + 1].value !== '!' || tokens[i + 2].value !== '(') continue;
    const close = closing(tokens, i + 2);
    if (close < 0) continue;
    const args = argumentsOf(tokens, i + 3, close);
    const calls = ([a, b]) => tokens.slice(a, b).some((t) => t.value === '(' || t.value === '!');
    const literal = ([a, b]) => b - a === 1 && /^(?:N|S|true|false)$/.test(tokens[a].value);
    if (/assert_eq$/.test(name)) {
      // Calls can differ between evaluations (render(&d), next()), so only call-free sides are certain.
      if (args.length >= 2 && !calls(args[0]) && text(tokens, args[0]) === text(tokens, args[1])) lines.push(tokens[i].line);
    } else if (args.length >= 1) {
      const [a, b] = args[0];
      if (b - a === 1 && tokens[a].raw === 'true') lines.push(tokens[i].line);
      else {
        let depth = 0;
        for (let k = a; k < b - 1; k++) {
          const v = tokens[k].value;
          if (v === '(' || v === '[' || v === '{') depth++;
          else if (v === ')' || v === ']' || v === '}') depth--;
          else if (depth === 0 && v === '=' && tokens[k + 1].value === '=' && tokens[k - 1]?.value !== '=' && tokens[k - 1]?.value !== '!' && tokens[k - 1]?.value !== '<' && tokens[k - 1]?.value !== '>') {
            // `x == x` is false for NaN: only literals are certain.
            if (literal([a, k]) && text(tokens, [a, k]) === text(tokens, [k + 2, b])) lines.push(tokens[i].line);
            break;
          }
        }
      }
    }
  }
  return lines;
}

/** Names brought in from test-helper modules (`use common::*` makes every outside call unknown). */
export function helperImports(tokens) {
  const names = new Set(); let glob = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'use') continue;
    let j = i + 1; const path = [];
    while (j < tokens.length && tokens[j].value !== ';') { path.push(tokens[j].value); j++; }
    const segments = path.filter((v) => /^[A-Za-z_]\w*$/.test(v));
    if (!segments.some((v) => HELPER_MODULE.has(v))) continue;
    if (path.includes('*')) glob = true;
    const at = path.lastIndexOf('{');
    if (at >= 0) { for (const v of path.slice(at + 1)) if (/^[A-Za-z_]\w*$/.test(v)) names.add(v); }
    else if (segments.length) names.add(segments.at(-1));
    i = j;
  }
  return { names, glob };
}

/**
 * Does [from, to) check anything? → true, false, or 'unknown'.
 * `bodies` resolves same-file helper functions, followed up to four levels deep.
 */
export function checks(tokens, from, to, bodies, seen = new Set(), depth = 0, helpers = { names: new Set(), glob: false }) {
  let unknown = false;
  for (let i = from; i < to; i++) {
    const t = tokens[i]; const next = tokens[i + 1]; const prev = tokens[i - 1];
    if (t.value === '?') return true;
    if (!ident(t)) continue;
    if (next?.value === '!') {
      if (ASSERT_MACRO.test(t.value)) return true;
      if (!QUIET_MACRO.has(t.value)) unknown = true;
      continue;
    }
    if (next?.value !== '(' || prev?.value === 'fn') continue;
    if (prev?.value === '.') { if (CHECKING_METHOD.test(t.value)) return true; continue; }
    if (CHECK_CALL.test(t.value)) return true;
    if (prev?.value === ':' && tokens[i - 2]?.value === ':') {
      let k = i - 3; let first = null;
      while (ident(tokens[k])) { first = tokens[k].value; if (tokens[k - 1]?.value === ':' && tokens[k - 2]?.value === ':') k -= 3; else break; }
      if (first && HELPER_MODULE.has(first)) { unknown = true; continue; }
      if (first !== 'super' && first !== 'self' && first !== 'crate') continue;
    }
    const helper = bodies.get(t.value);
    if (!helper) {
      // A helper from a test module, or any outside call when one is glob-imported, may check.
      if (helpers.names.has(t.value) || (helpers.glob && prev?.value !== ':')) unknown = true;
      continue;
    }
    if (seen.has(t.value)) continue;
    if (depth >= 4) { unknown = true; continue; }
    seen.add(t.value);
    for (const [open, close] of helper) {
      const inner = checks(tokens, open + 1, close, bodies, seen, depth + 1, helpers);
      if (inner === true) return true;
      if (inner === 'unknown') unknown = true;
    }
  }
  return unknown ? 'unknown' : false;
}

/** Findings for one test function: [{ kind, line }]. */
// Tests whose check is that nothing panics (fuzzing, robustness) need no assertion.
const NO_PANIC_NAME = /(?:^|_)(?:never|no|not|without|doesnt|does_not|cannot)_(?:panics?|crash(?:es)?|abort)(?:_|$)/;

export function assertionFindings(tokens, { attrs, signatureFrom, bodyOpen, bodyClose, line, bodies, helpers, name = '' }) {
  // An ignored test does not run in an ordinary `cargo test`: nothing to judge.
  if (attrs.some((attr) => /^ignore\b/.test(attr))) return [];
  const findings = tautologies(tokens, bodyOpen + 1, bodyClose).map((at) => ({ kind: 'tautology', line: at }));
  if (NO_PANIC_NAME.test(name)) return findings;
  const shouldPanic = attrs.some((attr) => /^should_panic/.test(attr));
  const returnsResult = tokens.slice(signatureFrom, bodyOpen).some((t) => t.value === 'Result');
  if (!shouldPanic && !returnsResult && checks(tokens, bodyOpen + 1, bodyClose, bodies, new Set(), 0, helpers) === false) findings.unshift({ kind: 'no-assertion', line });
  return findings;
}
