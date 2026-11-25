// Fault switching for Rust ("mutant schemata"): rewrite ONE Rust source file
// so that many cargo-mutants faults are compiled into one build, each switched
// on at run time by a number (env CUPEL_FAULT, read by FAULT_MODULE).
//
// The promise is reliability. With every switch off, the rewritten file must
// mean exactly what the original meant, and every original token must stay on
// its original line. So the rewrite only touches faults it has positively
// identified: an operator or a function body that a small, conservative
// parser of Rust function bodies found in an ordinary run-time expression.
// Anything it does not understand is refused, and a refused fault gets an
// ordinary one-fault-per-build run elsewhere.
//
// Pure: no I/O, no node: imports.

/** One line of Rust, appended (on a line of its own) to the crate root. */
export const FAULT_MODULE = '#[doc(hidden)] #[allow(dead_code, unused)] pub mod __cupel_faults { pub fn on(n: u32) -> bool { n != 0 && active() == n } pub fn active() -> u32 { *F.get_or_init(|| ::std::env::var("CUPEL_FAULT").ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0)) } static F: ::std::sync::OnceLock<u32> = ::std::sync::OnceLock::new(); }';

export function faultModule() { return FAULT_MODULE; }

// ---------------------------------------------------------------------------
// Lexer. Tolerant: never throws; unknown input becomes a 'bad' token.
// Token: { k, s, e, v, j?, m?, raw?, nl? }
//   k: 'id' | 'lt' (lifetime/label) | 'lit' | 'p' (one punctuation char) |
//      'o' / 'c' (open / close delimiter) | 'doc' (doc comment) | 'bad'
//   s, e: UTF-16 offsets; j: punct joint with the next punct; m: matching
//   delimiter index; raw: raw identifier; nl: literal holds a line break.

const PUNCT = new Set('!#$%&*+,-./:;<=>?@^|~'.split(''));
const PAIR = { '(': ')', '[': ']', '{': '}' };
const ID_START = /[\p{XID_Start}_]/u;
const ID_CONT = /\p{XID_Continue}/u;
const WS = new Set([' ', '\t', '\n', '\v', '\f', '\r', '\u0085', '\u200E', '\u200F', '\u2028', '\u2029']);

const cpAt = (text, i) => { const c = text.codePointAt(i); return c === undefined ? '' : String.fromCodePoint(c); };
const isIdStart = (ch) => ch !== '' && ID_START.test(ch);
const isIdCont = (ch) => ch !== '' && ID_CONT.test(ch);

export function lexRust(text) {
  const toks = [];
  const n = text.length;
  let i = 0;
  const push = (k, s, e, extra) => { toks.push({ k, s, e, v: text.slice(s, e), ...extra }); return e; };
  const identEnd = (k) => { while (k < n) { const ch = cpAt(text, k); if (!isIdCont(ch)) break; k += ch.length; } return k; };
  const suffix = (k) => (isIdStart(cpAt(text, k)) ? identEnd(k) : k);
  // k is just after the opening quote; returns the index after the closing quote, or -1.
  const quoted = (k, q) => { while (k < n) { const c = text[k]; if (c === '\\') { k += 2; continue; } if (c === q) return k + 1; k++; } return -1; };
  // k at the first '#' or '"' after an r prefix.
  const rawEnd = (k) => {
    let h = 0; while (text[k] === '#') { h++; k++; }
    if (text[k] !== '"') return -1;
    const close = '"' + '#'.repeat(h); const e = text.indexOf(close, k + 1);
    return e < 0 ? -1 : e + close.length;
  };
  const lit = (s, e) => { e = suffix(e); i = push('lit', s, e, { nl: /[\n\r]/.test(text.slice(s, e)) }); };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  if (text.startsWith('#!', i)) { // shebang line (not an inner attribute)
    let k = i + 2; while (k < n && WS.has(text[k])) k++;
    if (text[k] !== '[') { while (i < n && text[i] !== '\n') i++; }
  }
  while (i < n) {
    const c = text[i];
    if (WS.has(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      let e = text.indexOf('\n', i); if (e < 0) e = n;
      if ((text[i + 2] === '/' && text[i + 3] !== '/') || text[i + 2] === '!') push('doc', i, e);
      i = e; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let d = 1, k = i + 2;
      while (k < n && d > 0) {
        if (text[k] === '/' && text[k + 1] === '*') { d++; k += 2; } else if (text[k] === '*' && text[k + 1] === '/') { d--; k += 2; } else k++;
      }
      if (d > 0) push('bad', i, k);
      else if ((text[i + 2] === '*' && text[i + 3] !== '*' && text[i + 3] !== '/') || text[i + 2] === '!') push('doc', i, k);
      i = k; continue;
    }
    if (c === 'r' || c === 'b' || c === 'c') {
      let k = i + 1;
      if ((c === 'b' || c === 'c') && text[k] === 'r') k++;
      if (text[k - 1] === 'r' && (text[k] === '"' || (text[k] === '#' && (text[k + 1] === '"' || text[k + 1] === '#')))) {
        const e = rawEnd(k); if (e < 0) { i = push('bad', i, n); continue; }
        lit(i, e); continue;
      }
      if (c === 'r' && text[i + 1] === '#' && isIdStart(cpAt(text, i + 2))) { i = push('id', i, identEnd(i + 2), { raw: true }); continue; }
      if ((c === 'b' || c === 'c') && text[i + 1] === '"') { const e = quoted(i + 2, '"'); if (e < 0) { i = push('bad', i, n); continue; } lit(i, e); continue; }
      if (c === 'b' && text[i + 1] === "'") { const e = quoted(i + 2, "'"); if (e < 0) { i = push('bad', i, n); continue; } lit(i, e); continue; }
    }
    if (c === '"') { const e = quoted(i + 1, '"'); if (e < 0) { i = push('bad', i, n); continue; } lit(i, e); continue; }
    if (c === "'") {
      const k = i + 1;
      if (text[k] === '\\') { const e = quoted(k, "'"); if (e < 0) { i = push('bad', i, i + 1); continue; } lit(i, e); continue; }
      const ch = cpAt(text, k);
      if (ch !== '' && text[k + ch.length] === "'") { lit(i, k + ch.length + 1); continue; }
      if (isIdStart(ch)) { i = push('lt', i, identEnd(k)); continue; }
      i = push('bad', i, i + 1); continue;
    }
    if (c >= '0' && c <= '9') {
      let k = i;
      if (c === '0' && /[xob]/.test(text[i + 1] ?? '')) {
        k += 2; while (k < n && /[0-9a-fA-F_]/.test(text[k])) k++;
      } else {
        while (k < n && /[0-9_]/.test(text[k])) k++;
        if (text[k] === '.' && text[k + 1] !== '.' && !isIdStart(cpAt(text, k + 1))) { k++; while (k < n && /[0-9_]/.test(text[k])) k++; }
        if (text[k] === 'e' || text[k] === 'E') {
          let q = k + 1; if (text[q] === '+' || text[q] === '-') q++;
          if (/[0-9_]/.test(text[q] ?? '')) { while (q < n && /[0-9_]/.test(text[q])) q++; k = q; }
        }
      }
      lit(i, k); continue;
    }
    const ch = cpAt(text, i);
    if (isIdStart(ch)) { i = push('id', i, identEnd(i)); continue; }
    if (PAIR[c]) { i = push('o', i, i + 1); continue; }
    if (c === ')' || c === ']' || c === '}') { i = push('c', i, i + 1); continue; }
    if (PUNCT.has(c)) { i = push('p', i, i + 1); continue; }
    i = push('bad', i, i + ch.length);
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k], u = toks[k + 1];
    if (t.k === 'p') t.j = !!u && u.k === 'p' && u.s === t.e;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser of function bodies. Records binary, compound-assignment and unary
// (`-`, `!`) operator nodes found in ordinary run-time expressions.

const KEYWORDS = new Set(('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref ' +
  'return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro ' +
  'override priv typeof unsized virtual yield try').split(' '));
const PATH_KW = new Set(['self', 'Self', 'super', 'crate']);
const NOSTART = new Set(['as', 'else', 'in', 'where', 'fn', 'struct', 'enum', 'impl', 'trait', 'type', 'mod', 'use', 'pub', 'extern', 'mut', 'ref', 'dyn', 'static', 'let']);
const GLUE3 = ['<<=', '>>=', '...', '..='];
const GLUE2 = ['::', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '<<', '>>', '..'];
const PREC = {
  '*': 11, '/': 11, '%': 11, '+': 10, '-': 10, '<<': 9, '>>': 9, '&': 8, '^': 7, '|': 6,
  '==': 5, '!=': 5, '<': 5, '>': 5, '<=': 5, '>=': 5, '&&': 4, '||': 3, '..': 2, '..=': 2,
  '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '^=': 1, '&=': 1, '|=': 1, '<<=': 1, '>>=': 1,
};
const CMP = new Set(['==', '!=', '<', '>', '<=', '>=']);
const BINARY_OPS = new Set(['*', '/', '%', '+', '-', '<<', '>>', '&', '^', '|', '==', '!=', '<', '>', '<=', '>=', '&&', '||']);
const COMPOUND_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '<<=', '>>=']);
// Root contexts where an `if .. else ..` needs no parentheses (and where
// rustc's unused_parens lint would fire on them).
const NO_PAREN = new Set(['stmt', 'let', 'assign', 'paren', 'arg', 'elem', 'index', 'field', 'arm', 'closure', 'jump', 'cond', 'scrutinee', 'forin', 'letscrut']);

const FAIL = { fail: true };
const fail = () => { throw FAIL; };

function analyze(text) {
  const toks = lexRust(text);
  const nt = toks.length;
  // Delimiter matching.
  const stack = [];
  let balanced = true;
  for (let k = 0; k < nt; k++) {
    const t = toks[k];
    if (t.k === 'o') stack.push(k);
    else if (t.k === 'c') {
      const o = stack.pop();
      if (o === undefined || PAIR[toks[o].v] !== t.v) { balanced = false; break; }
      toks[o].m = k; t.m = o;
    }
  }
  if (stack.length) balanced = false;
  const out = { toks, balanced, nodes: [], fns: [], zone: new Array(nt), opaque: new Map(), failures: [] };
  if (!balanced) return out;
  const { zone, opaque, nodes, fns } = out;

  const isP = (k, v) => toks[k]?.k === 'p' && toks[k].v === v;
  const isId = (k, v) => toks[k]?.k === 'id' && !toks[k].raw && toks[k].v === v;
  const isOpen = (k, v) => toks[k]?.k === 'o' && toks[k].v === v;
  const glued = (k, s) => {
    for (let x = 0; x < s.length; x++) {
      const t = toks[k + x];
      if (!t || t.k !== 'p' || t.v !== s[x]) return false;
      if (x < s.length - 1 && !t.j) return false;
    }
    return true;
  };
  const tokenAt = (k) => {
    for (const g of GLUE3) if (glued(k, g)) return g;
    for (const g of GLUE2) if (glued(k, g)) return g;
    return toks[k].v;
  };
  const arrowGt = (k) => k > 0 && toks[k - 1].k === 'p' && toks[k - 1].j && (toks[k - 1].v === '-' || toks[k - 1].v === '=');
  const markZone = (a, b, why) => { for (let k = a; k < b; k++) if (zone[k] === undefined) zone[k] = why; };

  // Opaque groups: attributes and macro invocation token trees.
  for (let k = 0; k < nt; k++) {
    const t = toks[k];
    if (isP(k, '#')) { let q = k + 1; if (isP(q, '!')) q++; if (isOpen(q, '[')) opaque.set(q, 'attribute'); }
    if (t.k === 'id' && (t.raw || !KEYWORDS.has(t.v)) && isP(k + 1, '!') && !glued(k + 1, '!=')) {
      let q = k + 2; if (toks[q]?.k === 'id') q++;
      if (toks[q]?.k === 'o') opaque.set(q, 'macro');
    }
  }
  for (const [o, why] of [...opaque].sort((x, y) => x[0] - y[0])) markZone(o, toks[o].m + 1, why);

  // `<` at k: index after the matching `>`, or -1.
  const angles = (k) => {
    let depth = 0;
    while (k < nt) {
      const t = toks[k];
      if (t.k === 'o') { k = t.m + 1; continue; }
      if (t.k === 'c' || t.k === 'doc' || t.k === 'bad') return -1;
      if (t.k === 'p') {
        if (t.v === '<') depth++;
        else if (t.v === '>' && !arrowGt(k)) { depth--; if (depth === 0) return k + 1; }
        else if (t.v === ';') return -1;
      }
      k++;
    }
    return -1;
  };

  // Function item signature at `fn` (k) followed by its name.
  const fnSig = (k) => {
    let p = k + 2;
    if (isP(p, '<')) { p = angles(p); if (p < 0) return null; }
    if (!isOpen(p, '(')) return null;
    p = toks[p].m + 1;
    let ret = null, depth = 0;
    if (glued(p, '->')) { ret = [p + 2, -1]; p += 2; }
    for (;;) {
      const t = toks[p];
      if (!t || t.k === 'c' || t.k === 'bad') return null;
      if (t.k === 'o') { if (t.v === '{' && depth === 0) break; p = t.m + 1; continue; }
      if (depth === 0 && isP(p, ';')) break;
      if (depth === 0 && isId(p, 'where') && ret && ret[1] < 0) ret[1] = p;
      if (isP(p, '<')) depth++;
      if (isP(p, '>') && !arrowGt(p)) depth--;
      p++;
    }
    if (ret && ret[1] < 0) ret[1] = p;
    let q = k - 1;
    while (q >= 0 && ((toks[q].k === 'id' && ['unsafe', 'async', 'extern', 'safe', 'default'].includes(toks[q].v)) || toks[q].k === 'lit')) q--;
    const isConst = isId(q, 'const');
    if (isP(p, ';')) return { body: -1, end: p + 1, ret, isConst };
    return { body: p, end: toks[p].m + 1, ret, isConst };
  };

  // Global pass: every fn item with a body, outside attributes and macros.
  for (let k = 0; k < nt; k++) {
    const t = toks[k];
    if (t.k === 'o' && opaque.has(k)) { k = t.m; continue; }
    if (isId(k, 'fn') && toks[k + 1]?.k === 'id') {
      const s = fnSig(k);
      if (s && s.body >= 0) fns.push({ fn: k, ...s });
    }
    if ((isId(k, 'const') || isId(k, 'static')) && (k === 0 || isP(k - 1, ';') || toks[k - 1].k === 'o' || toks[k - 1].k === 'c' || isId(k - 1, 'pub') || isId(k - 1, 'mut'))
      && toks[k + 1]?.k === 'id' && !['fn', 'unsafe', 'async', 'extern'].includes(toks[k + 1].v)) {
      let q = k; while (q < nt && !isP(q, ';')) { if (toks[q].k === 'c') break; q = toks[q].k === 'o' ? toks[q].m + 1 : q + 1; }
      markZone(k, q, 'const');
    }
  }

  // ---- recursive descent over one range [i, hi) ----
  let i = 0, hi = 0, fnConst = false, refuseCtx = null, failAt = -1;
  const fail = () => { failAt = i; throw FAIL; };
  const group = (k, body) => {
    const saveHi = hi; i = k + 1; hi = toks[k].m;
    try { body(); if (i !== hi) fail(); } finally { hi = saveHi; }
    i = toks[k].m + 1;
  };
  const cur = () => (i < hi ? toks[i] : null);
  const record = (node) => { node.fnConst = fnConst; node.attr = refuseCtx; nodes.push(node); return node; };
  const canStart = (k, r) => {
    if (k >= hi) return false;
    const t = toks[k];
    switch (t.k) {
      case 'lit': case 'lt': return true;
      case 'id': return t.raw || !NOSTART.has(t.v);
      case 'o': return t.v !== '{' || !r.noStruct;
      case 'p': return '-!*&|<#'.includes(t.v) || glued(k, '..') || glued(k, '::');
      default: return false;
    }
  };
  // Scan a pattern from k to the first top-level token where stop(k) holds.
  const scanTo = (k, stop) => {
    while (k < hi) {
      if (stop(k)) return k;
      const t = toks[k];
      if (t.k === 'o') { k = t.m + 1; continue; }
      if (t.k === 'c' || t.k === 'bad' || t.k === 'doc' || isP(k, ';')) return -1;
      k++;
    }
    return -1;
  };
  const isAssignEq = (k) => isP(k, '=') && !(toks[k].j && (isP(k + 1, '=') || isP(k + 1, '>')))
    && !(k > 0 && toks[k - 1].k === 'p' && toks[k - 1].j && '=!<>.+-*/%^&|'.includes(toks[k - 1].v));
  const singleColon = (k) => isP(k, ':') && !glued(k, '::') && !(k > 0 && glued(k - 1, '::'));
  const expectBlock = () => { if (!isOpen(i, '{')) fail(); group(i, blockBody); };
  const skipAngles = (k) => { const e = angles(k); if (e < 0 || e > hi) fail(); markZone(k, e, 'generic'); return e; };

  function blockBody() {
    while (i < hi) {
      const mark = nodes.length, start = i;
      try { statement(); } catch (e) {
        if (e !== FAIL) throw e;
        nodes.length = mark;
        out.failures.push(failAt);
        let k = start;
        while (k < hi && !isP(k, ';')) k = toks[k].k === 'o' ? toks[k].m + 1 : k + 1;
        markZone(start, k, 'unparsed');
        i = k < hi ? k + 1 : hi;
      }
    }
  }

  function statement() {
    if (isP(i, ';')) { i++; return; }
    let attr = false;
    for (;;) {
      if (cur()?.k === 'doc') { attr = true; i++; continue; }
      if (isP(i, '#')) {
        let k = i + 1; if (isP(k, '!')) k++;
        if (!isOpen(k, '[')) fail();
        attr = true; i = toks[k].m + 1; continue;
      }
      break;
    }
    if (i >= hi) return;
    const saved = refuseCtx;
    if (attr) refuseCtx = 'attribute';
    try { statementInner(); } finally { refuseCtx = saved; }
  }

  function statementInner() {
    if (isId(i, 'let')) return letStatement();
    if (isItemStart(i)) return skipItem();
    if (blockLikeStart(i)) {
      // Like rustc and syn: a block-like expression statement ends at its
      // closing brace unless `.` or `?` continues it.
      const b = prefix({}, true);
      if (!continues(i)) { b.root ??= 'stmt'; if (isP(i, ';')) i++; return; }
      const e = expr(0, {}, postfix(b, {})); e.root ??= 'stmt';
      if (isP(i, ';')) { e.semi = true; i++; return; }
      if (i >= hi) return;
      fail();
    }
    const e = expr(0, {}); e.root ??= 'stmt';
    if (isP(i, ';')) { e.semi = true; i++; return; }
    if (i >= hi) return;
    if (e.kind === 'macro' && e.brace) return;
    fail();
  }

  function blockLikeStart(k) {
    if (isOpen(k, '{')) return true;
    if (isId(k, 'if') || isId(k, 'match') || isId(k, 'loop') || isId(k, 'while') || isId(k, 'for')) return true;
    if (isId(k, 'unsafe') && isOpen(k + 1, '{')) return true;
    return toks[k]?.k === 'lt' && singleColon(k + 1);
  }

  function isItemStart(k) {
    const t = toks[k];
    if (!t || t.k !== 'id' || t.raw) return false;
    switch (t.v) {
      case 'fn': case 'struct': case 'enum': case 'trait': case 'impl': case 'mod': case 'use': case 'type': case 'static': case 'extern': case 'pub': return true;
      case 'const': case 'unsafe': return !isOpen(k + 1, '{');
      case 'async': return isId(k + 1, 'fn') || isId(k + 1, 'unsafe');
      case 'union': case 'auto': return toks[k + 1]?.k === 'id';
      case 'macro_rules': return isP(k + 1, '!');
      default: return false;
    }
  }

  function skipItem() {
    const a = i;
    let k = i;
    while (isId(k, 'pub')) { k++; if (isOpen(k, '(')) k = toks[k].m + 1; }
    let sawConst = false;
    for (;;) {
      if (isId(k, 'const')) { sawConst = true; k++; continue; }
      if (isId(k, 'unsafe') || isId(k, 'async') || isId(k, 'default') || isId(k, 'safe')) { k++; continue; }
      if (isId(k, 'extern')) { k++; if (toks[k]?.k === 'lit') k++; continue; }
      break;
    }
    if (isId(k, 'fn')) {
      if (toks[k + 1]?.k !== 'id') fail();
      const s = fnSig(k); if (!s || s.end > hi) fail();
      i = s.end; return;
    }
    const toSemi = (q) => { while (q < hi && !isP(q, ';')) q = toks[q].k === 'o' ? toks[q].m + 1 : q + 1; if (q >= hi) fail(); return q + 1; };
    if (sawConst || isId(k, 'static')) { const e = toSemi(k); markZone(a, e, 'const'); i = e; return; }
    if (isId(k, 'macro_rules')) {
      k += 2; if (toks[k]?.k === 'id') k++;
      if (!(toks[k]?.k === 'o') || toks[k].m >= hi) fail();
      k = toks[k].m + 1; if (isP(k, ';')) k++;
      markZone(a, k, 'macro'); i = k; return;
    }
    let depth = 0;
    while (k < hi) {
      const t = toks[k];
      if (t.k === 'o') { const end = t.m + 1; if (t.v === '{' && depth === 0) { k = end; break; } k = end; continue; }
      if (t.k === 'c' || t.k === 'bad') fail();
      if (isP(k, ';') && depth === 0) { k++; break; }
      if (isP(k, '<')) depth++;
      if (isP(k, '>') && !arrowGt(k)) depth--;
      k++;
    }
    i = k;
  }

  function letStatement() {
    i++;
    let k = i, inType = false, depth = 0;
    while (k < hi) {
      const t = toks[k];
      if (t.k === 'o') { k = t.m + 1; continue; }
      if (t.k === 'c' || t.k === 'bad' || t.k === 'doc') fail();
      if (t.k === 'p') {
        if (glued(k, '::')) { k += 2; continue; }
        if (!inType && singleColon(k)) { inType = true; k++; continue; }
        if (inType && t.v === '<') depth++;
        if (inType && t.v === '>' && !arrowGt(k)) depth--;
        if (depth === 0 && (t.v === ';' || isAssignEq(k))) break;
      }
      k++;
    }
    if (k >= hi) fail();
    markZone(i, k, 'pattern');
    i = k;
    if (isP(i, ';')) { i++; return; }
    i++;
    const e = expr(0, {}); e.root ??= 'let';
    if (isId(i, 'else')) { e.root = 'letelse'; i++; expectBlock(); }
    if (!isP(i, ';')) fail();
    i++;
  }

  // Pratt parser.
  const continues = (k) => (isP(k, '.') && !glued(k, '..')) || isP(k, '?');

  function expr(minPrec, r, start = null) {
    let lhs = start ?? prefix(r, false);
    const rn = { noStruct: r.noStruct };
    for (;;) {
      if (i >= hi) break;
      const t = toks[i];
      if (isId(i, 'as')) {
        if (12 < minPrec) break;
        i++; castType();
        lhs = { kind: 'cast', a: lhs.a, b: i };
        continue;
      }
      if (t.k !== 'p') break;
      const op = tokenAt(i);
      const p = PREC[op];
      if (p === undefined || p < minPrec) break;
      const opI = i;
      i += op.length;
      if (op === '..' || op === '..=') {
        if (canStart(i, r)) expr(3, rn);
        lhs = { kind: 'range', a: lhs.a, b: i };
        continue;
      }
      if (CMP.has(op) && lhs.kind === 'binary' && CMP.has(lhs.op)) fail();
      const rhs = p === 1 ? expr(1, rn) : expr(p + 1, op === '&&' ? r : rn);
      const kind = op === '=' ? 'assign' : p === 1 ? 'compound' : 'binary';
      const node = { kind, op, opI, a: lhs.a, b: i, l: lhs, r: rhs };
      if (kind !== 'binary') rhs.root ??= 'assign';
      if (kind !== 'assign') record(node);
      lhs = node;
    }
    return lhs;
  }

  function castType() {
    const t = cur(); if (!t) fail();
    if (isP(i, '&')) { i++; if (cur()?.k === 'lt') i++; if (isId(i, 'mut')) i++; return castType(); }
    if (isP(i, '*')) { i++; if (!isId(i, 'const') && !isId(i, 'mut')) fail(); i++; return castType(); }
    if (t.k === 'o' && t.v !== '{') { markZone(i, t.m + 1, 'type'); i = t.m + 1; return; }
    if (t.k !== 'id' || (!t.raw && KEYWORDS.has(t.v) && !PATH_KW.has(t.v))) fail();
    i++;
    while (glued(i, '::') && toks[i + 2]?.k === 'id') i += 3;
    if (isP(i, '<') || glued(i, '::')) fail();
  }

  function prefix(r, stmt) {
    const a = i;
    const t = cur(); if (!t) fail();
    const rn = { noStruct: r.noStruct };
    const post = (node) => (stmt ? node : postfix(node, r));
    if (t.k === 'p') {
      const tk = tokenAt(i);
      if (tk === '-' || tk === '!' || tk === '*') {
        i++;
        const x = prefix(rn, false);
        const node = { kind: 'unary', op: tk, opI: a, a, b: i, x };
        if (tk !== '*') record(node);
        return node;
      }
      if (t.v === '&' && (tk === '&' || tk === '&&')) {
        i++;
        if (isId(i, 'raw') && (isId(i + 1, 'const') || isId(i + 1, 'mut'))) fail();
        if (isId(i, 'mut')) i++;
        const x = prefix(rn, false);
        return { kind: 'ref', a, b: i, x };
      }
      if (tk === '||' || tk === '|') return closure(a, r);
      if (tk === '..' || tk === '..=') { i += tk.length; if (canStart(i, r)) expr(3, rn); return { kind: 'range', a, b: i }; }
      if (tk === '::' || tk === '<') return pathExpr(a, r);
      fail();
    }
    if (t.k === 'lit') { i++; return post({ kind: 'lit', a, b: i }); }
    if (t.k === 'lt') {
      if (!singleColon(i + 1)) fail();
      i += 2;
      if (isOpen(i, '{')) group(i, blockBody);
      else if (isId(i, 'loop') || isId(i, 'while') || isId(i, 'for')) loopish();
      else fail();
      return post({ kind: 'block', a, b: i });
    }
    if (t.k === 'o') {
      if (t.v === '(') { group(i, () => list('paren')); return post({ kind: 'group', a, b: i }); }
      if (t.v === '[') { group(i, arrayBody); return post({ kind: 'group', a, b: i }); }
      group(i, blockBody); return post({ kind: 'block', a, b: i });
    }
    if (t.k !== 'id') fail();
    if (t.raw) return pathExpr(a, r);
    switch (t.v) {
      case 'true': case 'false': i++; return post({ kind: 'lit', a, b: i });
      case 'if': {
        i++; cond(); expectBlock();
        while (isId(i, 'else')) {
          i++;
          if (isId(i, 'if')) { i++; cond(); expectBlock(); continue; }
          expectBlock(); break;
        }
        return post({ kind: 'if', a, b: i });
      }
      case 'match': {
        i++;
        const e = expr(0, { noStruct: true }); e.root ??= 'scrutinee';
        if (!isOpen(i, '{')) fail();
        group(i, matchBody);
        return post({ kind: 'match', a, b: i });
      }
      case 'loop': case 'while': case 'for': loopish(); return post({ kind: 'loop', a, b: i });
      case 'unsafe': if (!isOpen(i + 1, '{')) fail(); i++; group(i, blockBody); return post({ kind: 'block', a, b: i });
      case 'async': {
        let k = i + 1; if (isId(k, 'move')) k++;
        if (isOpen(k, '{')) { i = k; group(i, blockBody); return post({ kind: 'block', a, b: i }); }
        return closure(a, r);
      }
      case 'move': return closure(a, r);
      case 'const': {
        if (!isOpen(i + 1, '{')) fail();
        markZone(i, toks[i + 1].m + 1, 'const');
        i = toks[i + 1].m + 1;
        return post({ kind: 'block', a, b: i });
      }
      case 'return': case 'break': case 'continue': {
        i++;
        if (t.v !== 'return' && cur()?.k === 'lt') i++;
        if (t.v !== 'continue' && canStart(i, r)) { const e = expr(0, rn); e.root ??= 'jump'; }
        return { kind: 'jump', a, b: i };
      }
      case 'let': {
        if (!r.cond) fail();
        i++;
        const k = scanTo(i, isAssignEq);
        if (k < 0 || k === i) fail();
        markZone(i, k, 'pattern');
        i = k + 1;
        const e = expr(5, { noStruct: true }); e.root ??= 'letscrut';
        return { kind: 'let', a, b: i };
      }
      default:
        if (KEYWORDS.has(t.v) && !PATH_KW.has(t.v)) fail();
        return pathExpr(a, r);
    }
  }

  function cond() { const e = expr(0, { noStruct: true, cond: true }); e.root ??= 'cond'; }

  function loopish() {
    const kw = toks[i].v;
    i++;
    if (kw === 'while') cond();
    if (kw === 'for') {
      const k = scanTo(i, (q) => isId(q, 'in'));
      if (k < 0 || k === i) fail();
      markZone(i, k, 'pattern');
      i = k + 1;
      const e = expr(0, { noStruct: true }); e.root ??= 'forin';
    }
    expectBlock();
  }

  function closure(a, r) {
    if (r.noStruct) fail();
    if (isId(i, 'async')) i++;
    if (isId(i, 'move')) i++;
    if (glued(i, '||')) i += 2;
    else if (isP(i, '|')) {
      const k = scanTo(i + 1, (q) => isP(q, '|'));
      if (k < 0) fail();
      markZone(i + 1, k, 'pattern');
      i = k + 1;
    } else fail();
    if (glued(i, '->')) {
      i += 2;
      let depth = 0;
      for (;;) {
        const t = cur(); if (!t) fail();
        if (t.k === 'o') { if (t.v === '{' && depth === 0) break; i = t.m + 1; continue; }
        if (t.k === 'c' || t.k === 'bad' || isP(i, ';') || (isP(i, ',') && depth === 0)) fail();
        if (isP(i, '<')) depth++;
        if (isP(i, '>') && !arrowGt(i)) depth--;
        i++;
      }
      expectBlock();
      return { kind: 'closure', a, b: i };
    }
    const e = expr(0, {}); e.root ??= 'closure';
    return { kind: 'closure', a, b: i };
  }

  function pathExpr(a, r) {
    if (isP(i, '<')) { // qualified path <T as Trait>::item
      i = skipAngles(i);
      if (!glued(i, '::')) fail();
    } else {
      if (glued(i, '::')) i += 2;
      const t = cur();
      if (!t || t.k !== 'id' || (!t.raw && KEYWORDS.has(t.v) && !PATH_KW.has(t.v))) fail();
      i++;
    }
    for (;;) {
      if (!glued(i, '::')) break;
      if (toks[i + 2]?.k === 'id' && i + 2 < hi) { i += 3; continue; }
      if (isP(i + 2, '<')) { i = skipAngles(i + 2); continue; }
      fail();
    }
    if (isP(i, '!') && !glued(i, '!=') && toks[i + 1]?.k === 'o' && i + 1 < hi) {
      const g = toks[i + 1];
      i = g.m + 1;
      return postfix({ kind: 'macro', a, b: i, brace: g.v === '{' }, r);
    }
    if (isOpen(i, '{') && !r.noStruct) { group(i, structBody); return postfix({ kind: 'struct', a, b: i }, r); }
    return postfix({ kind: 'path', a, b: i }, r);
  }

  function postfix(node, r) {
    for (;;) {
      if (isP(i, '?')) { i++; node = { kind: 'postfix', a: node.a, b: i }; continue; }
      if (isP(i, '.') && !glued(i, '..')) {
        const t = toks[i + 1];
        if (!t || i + 1 >= hi) fail();
        if (t.k === 'id') {
          i += 2;
          if (!(!t.raw && t.v === 'await')) {
            if (glued(i, '::') && isP(i + 2, '<')) i = skipAngles(i + 2);
            if (isOpen(i, '(')) group(i, () => list('arg'));
          }
          node = { kind: 'postfix', a: node.a, b: i }; continue;
        }
        if (t.k === 'lit' && /^[0-9][0-9.]*$/.test(t.v)) { i += 2; node = { kind: 'postfix', a: node.a, b: i }; continue; }
        fail();
      }
      if (isOpen(i, '(')) { group(i, () => list('arg')); node = { kind: 'postfix', a: node.a, b: i }; continue; }
      if (isOpen(i, '[')) { group(i, () => { const e = expr(0, {}); e.root ??= 'index'; }); node = { kind: 'postfix', a: node.a, b: i }; continue; }
      break;
    }
    void r;
    return node;
  }

  function list(ctx) {
    while (i < hi) {
      if (isP(i, '#') || cur().k === 'doc') fail();
      const e = expr(0, {}); e.root ??= ctx;
      if (i < hi) { if (!isP(i, ',')) fail(); i++; }
    }
  }

  function arrayBody() {
    if (i >= hi) return;
    if (isP(i, '#') || cur().k === 'doc') fail();
    const e = expr(0, {}); e.root ??= 'elem';
    if (isP(i, ';')) { markZone(i + 1, hi, 'const'); i = hi; return; }
    if (i < hi) { if (!isP(i, ',')) fail(); i++; }
    list('elem');
  }

  // Outer attributes (and doc comments) before a field or arm; what follows
  // is refused as 'attribute' while `body` runs.
  function withAttrs(body) {
    let attr = false;
    for (;;) {
      if (cur()?.k === 'doc') { attr = true; i++; continue; }
      if (isP(i, '#') && isOpen(i + 1, '[')) { attr = true; i = toks[i + 1].m + 1; continue; }
      break;
    }
    const saved = refuseCtx;
    if (attr) refuseCtx = 'attribute';
    try { body(); } finally { refuseCtx = saved; }
  }

  function structBody() {
    while (i < hi) {
      if (glued(i, '..')) {
        i += 2;
        if (i < hi) { const e = expr(0, {}); e.root ??= 'field'; }
        if (i !== hi) fail();
        break;
      }
      withAttrs(() => {
        const t = cur(); if (!t) fail();
        if ((t.k === 'id' || (t.k === 'lit' && /^[0-9]+$/.test(t.v))) && singleColon(i + 1)) {
          i += 2; const e = expr(0, {}); e.root ??= 'field';
        } else if (t.k === 'id') i++;
        else fail();
      });
      if (i < hi) { if (!isP(i, ',')) fail(); i++; }
    }
  }

  function matchBody() {
    while (i < hi) withAttrs(arm);
  }

  function arm() {
    const k = scanTo(i, (q) => glued(q, '=>') || isId(q, 'if'));
    if (k < 0 || k === i) fail();
    markZone(i, k, 'pattern');
    i = k;
    if (isId(i, 'if')) { i++; const g = expr(0, {}); g.root ??= 'guard'; if (!glued(i, '=>')) fail(); }
    i += 2;
    const e = blockLikeStart(i) ? prefix({}, true) : null;
    if (e && !continues(i)) { if (isP(i, ',')) i++; return; }
    const body = expr(0, {}, e ? postfix(e, {}) : null); body.root ??= 'arm';
    if (i < hi) { if (!isP(i, ',')) fail(); i++; }
  }

  for (const f of fns) {
    fnConst = f.isConst; refuseCtx = null;
    i = f.body; hi = nt;
    const mark = nodes.length;
    try { group(f.body, blockBody); } catch (e) { if (e !== FAIL) throw e; nodes.length = mark; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Positions: cargo-mutants lines are 1-based, columns 1-based in Unicode
// scalar values; `end` is exclusive.

function lineStarts(text) {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
  return starts;
}

function offsetOf(text, starts, pos) {
  if (!pos || !Number.isInteger(pos.line) || !Number.isInteger(pos.column) || pos.line < 1 || pos.column < 1) return -1;
  if (pos.line > starts.length) return -1;
  let k = starts[pos.line - 1];
  const end = pos.line < starts.length ? starts[pos.line] - 1 : text.length;
  for (let c = 1; c < pos.column; c++) {
    if (k >= end) return -1;
    k += text.codePointAt(k) > 0xffff ? 2 : 1;
  }
  return k;
}

// ---------------------------------------------------------------------------

const PATH_RE = /^(::)?[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;
const STARTS_BLOCK = new Set(['if', 'match', 'loop', 'while', 'for', 'unsafe', 'async', 'const', 'move', 'return', 'break', 'continue', 'let', 'static', 'yield']);

/** Diagnostics: offsets where statement parsing gave up (those statements are refused). */
export function parseFailures(text) {
  const an = analyze(text);
  return an.failures.map((k) => an.toks[k]?.s ?? text.length);
}

/**
 * Rewrite `text` so each accepted fault is switched by `path(number)`.
 * Faults: [{ number, genre, span, replacement }] as in `cargo mutants --list --json`.
 * Refusal reasons: genre, number, span, replacement, operator, statement, ambiguous,
 * multiline, return-type, overlap, column, and where the fault sits: macro, attribute,
 * const, pattern, generic, type, item (outside any fn body), unparsed.
 * @returns {{ text: string, switched: number[], refused: {number: number, reason: string}[] }}
 */
export function switchFaults(text, faults, { path = 'crate::__cupel_faults::on' } = {}) {
  if (typeof text !== 'string') throw new TypeError('switchFaults: text must be a string');
  if (!PATH_RE.test(path)) throw new TypeError(`switchFaults: not a Rust path: ${path}`);
  const refused = [];
  const refuse = (number, reason) => { refused.push({ number, reason }); };
  const list = [...(faults ?? [])].sort((x, y) => (x?.number ?? 0) - (y?.number ?? 0));
  const an = analyze(text);
  const { toks } = an;
  const starts = lineStarts(text);
  const byStart = new Map(toks.map((t, k) => [t.s, k]));
  const nodeAt = new Map();
  for (const node of an.nodes) nodeAt.set(node.opI, node);
  const fileHasColumn = toks.some((t, k) => t.k === 'id' && t.v === 'column' && toks[k + 1]?.k === 'p' && toks[k + 1].v === '!');
  const bodyOf = (k) => {
    let best = null;
    for (const f of an.fns) { const o = f.body, c = toks[o].m; if (k > o && k < c && (!best || o > best.body)) best = f; }
    return best;
  };
  const why = (k) => {
    if (an.zone[k]) return an.zone[k];
    const f = bodyOf(k);
    if (!f) return 'item';
    return f.isConst ? 'const' : 'unparsed';
  };

  const startsBlock = (a) => {
    const t = toks[a];
    if (t.k === 'o' && t.v === '{') return true;
    if (t.k === 'lt') return true;
    if (t.k === 'p' && t.v === '|') return true;
    return t.k === 'id' && !t.raw && STARTS_BLOCK.has(t.v);
  };
  // The operand is one parenthesized group already: no second pair needed.
  const isGroup = (a, b) => toks[a].k === 'o' && toks[a].v === '(' && toks[a].m === b - 1;
  const operandOk = (a, b) => !startsBlock(a) && !(toks[b - 1].k === 'c' && toks[b - 1].v === '}');
  // Operand tokens on one line, comments dropped; throws a reason string.
  const oneLine = (a, b) => {
    let s = '';
    for (let k = a; k < b; k++) {
      const t = toks[k];
      if (t.k === 'doc' || t.k === 'bad' || (t.k === 'lit' && t.nl)) throw 'multiline';
      if (t.k === 'id' && (t.v === 'line' || t.v === 'column') && toks[k + 1]?.k === 'p' && toks[k + 1].v === '!') throw 'multiline';
      if (k > a) s += toks[k - 1].e === t.s ? '' : ' ';
      s += t.v;
    }
    return s;
  };

  const accepted = [];
  const seen = new Set();
  for (const f of list) {
    const number = f?.number;
    if (!Number.isInteger(number) || number < 1 || number > 0xffffffff || seen.has(number)) { refuse(number, 'number'); continue; }
    seen.add(number);
    const genre = f.genre;
    if (genre !== 'BinaryOperator' && genre !== 'UnaryOperator' && genre !== 'FnValue') { refuse(number, 'genre'); continue; }
    if (!an.balanced) { refuse(number, 'unparsed'); continue; }
    if (fileHasColumn) { refuse(number, 'column'); continue; }
    const ss = offsetOf(text, starts, f.span?.start), se = offsetOf(text, starts, f.span?.end);
    if (ss < 0 || se < 0 || se <= ss) { refuse(number, 'span'); continue; }
    const repl = typeof f.replacement === 'string' ? f.replacement : null;
    if (repl === null) { refuse(number, 'replacement'); continue; }
    try {
      if (genre === 'FnValue') accepted.push({ number, ...fnValue(ss, se, repl) });
      else {
        const k = byStart.get(ss);
        if (k === undefined || toks[k].k !== 'p') throw 'span';
        const node = nodeAt.get(k);
        if (!node) throw why(k);
        if (node.attr) throw node.attr;
        if (node.fnConst) throw 'const';
        if (text.slice(ss, se) !== node.op || toks[k + node.op.length - 1].e !== se) throw 'span';
        if ((genre === 'UnaryOperator') !== (node.kind === 'unary')) throw 'operator';
        if (genre === 'UnaryOperator') accepted.push({ number, ...unary(node, repl) });
        else accepted.push({ number, ...binary(node, repl) });
      }
    } catch (reason) {
      if (typeof reason !== 'string') throw reason;
      refuse(number, reason);
    }
  }

  function fnValue(ss, se, repl) {
    const f = an.fns.find((g) => {
      const o = g.body, c = toks[o].m;
      if (c === o + 1) return false;
      return (toks[o + 1].s === ss && toks[c - 1].e === se) || (toks[o].s === ss && toks[c].e === se);
    });
    if (!f) {
      const k = byStart.get(ss);
      throw k !== undefined && an.zone[k] ? an.zone[k] : 'span';
    }
    if (f.isConst) throw 'const';
    if (f.ret) {
      const [a, b] = f.ret;
      if (a >= b || (toks[a].k === 'p' && toks[a].v === '!')) throw 'return-type';
      for (let k = a; k < b; k++) if (toks[k].k === 'id' && !toks[k].raw && toks[k].v === 'impl') throw 'return-type';
    }
    const o = f.body, c = toks[o].m;
    const first = toks[o + 1];
    if (first.k === 'doc' || (first.k === 'p' && first.v === '#')) throw 'attribute';
    checkReplacement(repl);
    return { kind: 'fn', rs: first.s, re: toks[c - 1].e, repl: repl.trim(), fn: f.fn };
  }

  function checkReplacement(repl) {
    if (/[\n\r\u2028\u2029]/.test(repl) || repl.trim() === '') throw 'replacement';
    const rt = lexRust(repl);
    // The lexer drops comments: any non-space text outside the tokens is one.
    let pos = 0;
    for (const t of [...rt, { s: repl.length, e: repl.length }]) {
      if (repl.slice(pos, t.s).trim() !== '') throw 'replacement';
      pos = t.e;
    }
    let depth = 0;
    const st = [];
    for (const t of rt) {
      if (t.k === 'bad' || t.k === 'doc' || (t.k === 'lit' && t.nl)) throw 'replacement';
      if (t.k === 'o') { st.push(PAIR[t.v]); depth++; }
      if (t.k === 'c') { if (st.pop() !== t.v) throw 'replacement'; depth--; }
      if (depth === 0 && t.k === 'p' && t.v === ';') throw 'replacement';
    }
    if (st.length) throw 'replacement';
  }

  function unary(node, repl) {
    if (node.op !== '-' && node.op !== '!') throw 'operator';
    if (repl.trim() !== '') throw 'replacement';
    const { x } = node;
    if (!operandOk(x.a, x.b)) throw 'ambiguous';
    const on = oneLine(x.a, x.b);
    return {
      kind: 'unary', rs: toks[node.opI].s, re: toks[x.b - 1].e, xs: toks[x.a].s,
      on, xPar: !isGroup(x.a, x.b), paren: !(node.root && NO_PAREN.has(node.root)),
    };
  }

  function binary(node, repl) {
    const r = repl.trim();
    if (node.kind === 'compound') {
      if (!COMPOUND_OPS.has(node.op)) throw 'operator';
      if (!COMPOUND_OPS.has(r)) throw 'replacement';
      if (node.root !== 'stmt' || !node.semi) throw 'statement';
    } else {
      if (!BINARY_OPS.has(node.op)) throw 'operator';
      if (!BINARY_OPS.has(r)) throw 'replacement';
    }
    const { l, r: rhs } = node;
    if (!operandOk(l.a, l.b) || !operandOk(rhs.a, rhs.b)) throw 'ambiguous';
    const lOn = oneLine(l.a, l.b), rOn = oneLine(rhs.a, rhs.b);
    return {
      kind: node.kind, rs: toks[l.a].s, re: toks[rhs.b - 1].e,
      le: toks[l.b - 1].e, rStart: toks[rhs.a].s,
      lOn, rOn, lPar: !isGroup(l.a, l.b), rPar: !isGroup(rhs.a, rhs.b), newOp: r, paren: !(node.root && NO_PAREN.has(node.root)),
    };
  }

  // Nesting: accept in number order; refuse partial overlaps.
  const kept = [];
  for (const f of accepted) {
    const clash = kept.some((g) => (f.rs < g.rs && g.rs < f.re && f.re < g.re) || (g.rs < f.rs && f.rs < g.re && g.re < f.re));
    if (clash) { refuse(f.number, 'overlap'); continue; }
    kept.push(f);
  }
  const order = [...kept].sort((x, y) => x.rs - y.rs || y.re - x.re || (x.kind === 'fn' ? 0 : 1) - (y.kind === 'fn' ? 0 : 1) || x.number - y.number);
  const roots = [];
  const st = [];
  for (const f of order) {
    f.kids = [];
    while (st.length && !(st[st.length - 1].rs <= f.rs && f.re <= st[st.length - 1].re)) st.pop();
    (st.length ? st[st.length - 1].kids : roots).push(f);
    st.push(f);
  }

  const call = (n) => `${path}(${n})`;
  const par = (yes, s) => (yes ? `(${s})` : s);
  // `wrapped`: the caller already puts this range in parentheses.
  const renderRange = (s, e, kids, wrapped = false) => {
    let outText = '', pos = s;
    for (const kid of kids) {
      if (kid.rs < s || kid.re > e) continue;
      outText += text.slice(pos, kid.rs) + renderNode(kid, !(wrapped && kid.rs === s && kid.re === e));
      pos = kid.re;
    }
    return outText + text.slice(pos, e);
  };
  const inside = (kids, s, e) => kids.filter((kid) => kid.rs >= s && kid.re <= e);
  function renderNode(f, outerParen) {
    if (f.kind === 'fn') return `if ${call(f.number)} { return ${f.repl}; } ` + renderRange(f.rs, f.re, f.kids);
    const same = f.kids.find((kid) => kid.rs === f.rs && kid.re === f.re);
    const wrap = (on, off) => {
      const body = `if ${call(f.number)} { ${on} } else { ${off} }`;
      return f.kind !== 'compound' && f.paren && outerParen ? `(${body})` : body;
    };
    if (f.kind === 'compound') {
      return wrap(`${f.lOn} ${f.newOp} ${f.rOn}`, same ? renderNode(same, false) : renderRange(f.rs, f.re, f.kids));
    }
    if (f.kind === 'unary') {
      const off = same ? renderNode(same, false)
        : text.slice(f.rs, f.xs) + par(f.xPar, renderRange(f.xs, f.re, inside(f.kids, f.xs, f.re), f.xPar));
      return wrap(f.on, off);
    }
    const off = same ? renderNode(same, false)
      : par(f.lPar, renderRange(f.rs, f.le, inside(f.kids, f.rs, f.le), f.lPar)) + text.slice(f.le, f.rStart)
        + par(f.rPar, renderRange(f.rStart, f.re, inside(f.kids, f.rStart, f.re), f.rPar));
    return wrap(`${par(f.lPar, f.lOn)} ${f.newOp} ${par(f.rPar, f.rOn)}`, off);
  }

  const rendered = renderRange(0, text.length, roots);
  refused.sort((x, y) => (x.number ?? 0) - (y.number ?? 0));
  return { text: rendered, switched: kept.map((f) => f.number).sort((x, y) => x - y), refused };
}
