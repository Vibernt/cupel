// Block coverage rebuilt from breakpoint hits (spike S30).
//
// workerd answers `Profiler.enable` itself (for its CPU profiler) and never
// forwards it to V8, so V8 precise coverage cannot start there. Debugger and
// Runtime commands are forwarded, so Cupel sets a never-pausing conditional
// breakpoint at every location V8 can stop at, records which ones run, and
// rebuilds V8-style covered character intervals from the hits:
//  - a hit location covers the code from it up to the next possible location,
//    never past the start of another function;
//  - entering a function covers its header (signature up to the body brace);
//  - module top-level code runs when workerd starts, before breakpoints can
//    exist; it is reported as setup when the script loaded, as Cupel already
//    treats module loading in Node.
// The rules are checked against real V8 block coverage of the same code in
// Node (test/workerd-ranges.test.mjs). Pure; standard library only.
import { matchBrackets, tokenize } from '../../lang/js/lexer.mjs';

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'await', 'yield', 'new',
  'delete', 'void', 'in', 'of', 'instanceof', 'do', 'else', 'case', 'throw']);
const MODIFIER = new Set(['async', 'static', 'get', 'set', '*']);

/** Function ranges { header, body, end } as character offsets; `end` is exclusive. */
export function functionRanges(src) {
  const toks = tokenize(src).filter((t) => t.type !== 'comment');
  const pairs = matchBrackets(toks);
  const v = (k) => toks[k]?.value;
  const out = [];
  const back = (k) => { while (k > 0 && MODIFIER.has(v(k - 1))) k--; return k; };
  for (let k = 0; k < toks.length; k++) {
    if (v(k) === '=>') {
      let start = k - 1;
      if (v(start) === ')' && pairs.has(start)) start = pairs.get(start);
      if (v(start - 1) === 'async') start--;
      if (v(k + 1) === '{' && pairs.has(k + 1)) {
        out.push({ header: toks[start].start, body: toks[k + 1].start, end: toks[pairs.get(k + 1)].end });
      } else {
        // An expression body runs to the first , ; ) ] } at its own depth.
        let q = k + 1; let last = k;
        while (q < toks.length && ![',', ';', ')', ']', '}'].includes(v(q))) {
          last = pairs.has(q) && pairs.get(q) > q ? pairs.get(q) : q;
          q = last + 1;
        }
        if (last > k) out.push({ header: toks[start].start, body: toks[k + 1].start, end: toks[last].end });
      }
      continue;
    }
    if (v(k) !== '{' || v(k - 1) !== ')' || !pairs.has(k - 1) || !pairs.has(k)) continue;
    const open = pairs.get(k - 1);
    let name = open - 1;
    if (v(name) === '*') name--;
    const word = toks[name];
    if (!word || CONTROL.has(word.value)) continue;
    let header;
    if (word.value === 'function') header = back(name);
    else if (word.type === 'name' || word.type === 'string' || v(name) === ']') {
      // `function name(`, `name(` in a class or object, `[computed](`.
      let at = name;
      if (v(name) === ']' && pairs.has(name)) at = pairs.get(name);
      if (v(at - 1) === 'function' || (v(at - 1) === '*' && v(at - 2) === 'function')) at = v(at - 1) === '*' ? at - 2 : at - 1;
      else if (v(name - 1) === '.') continue; // a call `a.b(...)` followed by a block cannot be a method
      header = back(at);
    } else continue;
    out.push({ header: toks[header].start, body: toks[k].start, end: toks[pairs.get(k)].end });
  }
  return out.sort((a, b) => a.header - b.header || b.end - a.end);
}

/** Offsets of the start of each line (0-based line numbers). */
export function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

const innermost = (ranges, offset) => {
  let best = null;
  for (const r of ranges) if (r.header <= offset && offset < r.end && (!best || r.header >= best.header)) best = r;
  return best;
};

/** Code outside every function: module top-level statements, as flat [s, e, ...] intervals. */
export function topLevelIntervals(src, ranges) {
  const out = [];
  let pos = 0;
  const outer = ranges.filter((r) => !ranges.some((o) => o !== r && o.header <= r.header && r.end <= o.end && (o.header < r.header || o.end > r.end)));
  for (const r of outer) { if (r.header > pos) out.push(pos, r.header); pos = Math.max(pos, r.end); }
  if (pos < src.length) out.push(pos, src.length);
  return out;
}

/** Offsets of tokens where a new block of control starts: else, case, default, catch, finally. */
export function controlStops(src) {
  const toks = tokenize(src).filter((t) => t.type !== 'comment');
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'name' || toks[k - 1]?.value === '.') continue;
    if (t.value === 'else' || t.value === 'catch' || t.value === 'finally' || t.value === 'case') out.push(t.start);
    else if (t.value === 'default' && toks[k + 1]?.value === ':') out.push(t.start);
  }
  return out.sort((a, b) => a - b);
}

/** Conditional expressions as { cons: [s, e), alt: [s, e) } character ranges of their two branches. */
export function ternaryBranches(src) {
  const toks = tokenize(src).filter((t) => t.type !== 'comment');
  const pairs = matchBrackets(toks);
  const out = [];
  const skip = (q) => (pairs.has(q) && pairs.get(q) > q ? pairs.get(q) : q);
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].value !== '?' || toks[k].type !== 'punct') continue;
    let depth = 0; let colon = -1;
    for (let q = k + 1; q < toks.length; q = skip(q) + 1) {
      const value = toks[q].value;
      if (value === '?' && toks[q].type === 'punct') depth++;
      else if (value === ':') { if (depth === 0) { colon = q; break; } depth--; }
      else if ([';', ',', ')', ']', '}'].includes(value)) break;
    }
    if (colon < 0 || colon === k + 1) continue;
    let last = colon;
    for (let end = colon + 1, depth2 = 0; end < toks.length; end = skip(end) + 1) {
      const value = toks[end].value;
      if (value === '?' && toks[end].type === 'punct') depth2++;
      else if (value === ':') { if (depth2 === 0) break; depth2--; }
      else if ([';', ',', ')', ']', '}'].includes(value)) break;
      last = skip(end);
    }
    if (last === colon) continue;
    out.push({ cons: [toks[k + 1].start, toks[colon - 1].end], alt: [toks[colon + 1].start, toks[last].end] });
  }
  return out;
}

const JUMP = new Set(['continue', 'break', 'return', 'throw']);
const CONTINUES = new Set(['else', 'catch', 'finally', 'while', ')', ',', '.', ';', '?', ':']);

/**
 * Statement blocks (`) {`, `else {`, `try {`, `finally {`, `do {`) as
 * { open, close, end, last }, excluding function bodies. `last` is the offset
 * where the block's last statement starts (null for an empty block).
 */
export function statementBlocks(src, ranges) {
  const toks = tokenize(src).filter((t) => t.type !== 'comment');
  const pairs = matchBrackets(toks);
  const bodies = new Set(ranges.map((r) => r.body));
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].value !== '{' || !pairs.has(k) || bodies.has(toks[k].start)) continue;
    const prev = toks[k - 1]?.value;
    if (prev !== ')' && prev !== 'else' && prev !== 'try' && prev !== 'finally' && prev !== 'do') continue;
    const close = pairs.get(k);
    let last = k + 1 < close ? k + 1 : null;
    for (let q = k + 1; q < close; q++) {
      if (pairs.has(q) && pairs.get(q) > q) {
        const end = pairs.get(q);
        // A nested block ends a statement unless the statement goes on (else, catch, a call, ...).
        if (toks[q].value === '{' && end + 1 < close && !CONTINUES.has(toks[end + 1].value)) last = end + 1;
        q = end;
        continue;
      }
      if (toks[q].value === ';' && q + 1 < close) last = q + 1;
    }
    const isSwitch = prev === ')' && pairs.has(k - 1) && toks[pairs.get(k - 1) - 1]?.value === 'switch';
    out.push({ open: toks[k].start, close: toks[close].start, end: toks[close].end, last: last === null ? null : toks[last].start, isSwitch });
  }
  return out;
}

/** Offsets where a jump statement (continue, break, return, throw) starts, with the end of that statement. */
export function jumpEnds(src) {
  const toks = tokenize(src).filter((t) => t.type !== 'comment');
  const pairs = matchBrackets(toks);
  const out = new Map();
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'name' || !JUMP.has(toks[k].value) || toks[k - 1]?.value === '.') continue;
    let q = k + 1;
    while (q < toks.length && toks[q].value !== ';' && toks[q].value !== '}' && toks[q].line === toks[k].line) {
      q = pairs.has(q) && pairs.get(q) > q ? pairs.get(q) + 1 : q + 1;
    }
    const endTok = toks[Math.min(q, toks.length - 1)];
    out.set(toks[k].start, endTok.value === ';' ? endTok.end : toks[q - 1].end);
  }
  return out;
}

/**
 * Covered intervals from hits. `locations` are { line, column } (0-based, V8's
 * possible breakpoints, any order); `hits` is a set of indexes into `locations`.
 *
 * A hit covers from its location to the next location of the same function,
 * skipping nested functions and stopping at else/case/default/catch/finally.
 * A hit also covers back to a block opening (`{`, else, case, ...) that lies
 * between it and the previous location of its function, so `} else {`,
 * `try {` and `case x:` lines are covered when their block runs. Entering a
 * function covers its header.
 */
export function paintHits(src, ranges, locations, hits) {
  const starts = lineStarts(src);
  const at = locations.map((l, index) => ({ index, type: l.type, offset: (starts[l.line] ?? src.length) + l.column })).sort((a, b) => a.offset - b.offset);
  for (const a of at) a.fn = innermost(ranges, a.offset);
  const stops = controlStops(src);
  const blocks = statementBlocks(src, ranges);
  const jumps = jumpEnds(src);
  const ternaries = ternaryBranches(src);
  // Forward marking stops where a new block or branch starts.
  const cuts = [...stops, ...blocks.map((b) => b.open)].sort((a, b) => a - b);
  const openers = cuts;
  const painted = [];
  // A ternary branch ran when a stop inside it ran, or when it has no stops
  // and the other branch has stops of which none ran.
  const within = ([a, b]) => at.filter((x) => x.offset >= a && x.offset < b);
  const ranBranch = (mine, other) => {
    const own = within(mine);
    if (own.length) return own.some((x) => hits.has(x.index));
    const theirs = within(other);
    return theirs.length > 0 && !theirs.some((x) => hits.has(x.index));
  };
  const skipped = [];
  for (const t of ternaries) {
    if (!ranBranch(t.cons, t.alt)) skipped.push(t.cons);
    if (!ranBranch(t.alt, t.cons)) skipped.push(t.alt);
  }
  const paint = (s, e, fn) => {
    // Leave out nested functions (painted when they run) and ternary branches that did not run.
    const holes = [];
    for (const r of ranges) {
      if (r === fn || r.header < s || r.header >= e) continue;
      if (innermost(ranges, r.header) !== r) continue;
      if (fn && !(fn.header <= r.header && r.end <= fn.end)) continue;
      holes.push([r.header, r.end]);
    }
    for (const [a, b] of skipped) if (a >= s && a < e && !(a <= s && s < b)) holes.push([a, b]);
    holes.sort((x, y) => x[0] - y[0]);
    let pos = s;
    for (const [a, b] of holes) { if (a > pos) painted.push([pos, Math.min(a, e)]); pos = Math.max(pos, b); }
    if (e > pos) painted.push([pos, e]);
  };
  const entry = (fn) => {
    // Entering a function runs its header and everything up to its first
    // stop, and its closing brace belongs to the function's own range.
    const first = at.find((a) => a.fn === fn);
    const cut = cuts.find((x) => x > fn.body && innermost(ranges, x) === fn);
    const out = [[fn.header, Math.max(fn.body + 1, first ? Math.min(first.offset, cut ?? first.offset) : fn.body + 1)]];
    if (src[fn.end - 1] === '}' && src[fn.body] === '{') out.push([fn.end - 1, fn.end]);
    return out;
  };
  for (let i = 0; i < at.length; i++) {
    if (!hits.has(at[i].index)) continue;
    const { offset: s, fn, type } = at[i];
    if (fn) painted.push(...entry(fn));
    const jumpStart = [...jumps.keys()].find((x) => x <= s && s <= jumps.get(x));
    // The return stop of an explicit `return` sits just after the statement:
    // nothing after it ran on this path. Implicit returns (an arrow's
    // expression, a function's end) do not end the enclosing statement.
    if (type === 'return' && jumpStart !== undefined && s >= jumps.get(jumpStart) - 1) continue;
    // Call positions that did not run (short-circuited by ?. and the like) are not range boundaries.
    let j = i + 1; while (j < at.length && (at[j].fn !== fn || (at[j].type === 'call' && !hits.has(at[j].index)))) j++;
    let e = j < at.length ? at[j].offset : fn ? fn.end : src.length;
    if (fn && e > fn.end) e = fn.end;
    const stop = cuts.find((x) => x > s && x < e && innermost(ranges, x) === fn);
    if (stop !== undefined) e = stop;
    // After a jump the rest of the block has its own count: stop at the jump's end.
    if (jumpStart !== undefined) e = Math.min(e, jumps.get(jumpStart));
    paint(s, e, fn);
    let p = i - 1; while (p >= 0 && at[p].fn !== fn) p--;
    const from = p >= 0 ? at[p].offset : fn ? fn.body : 0;
    const opener = openers.filter((x) => x > from && x < s && innermost(ranges, x) === fn).at(-1);
    if (opener !== undefined) paint(opener, s, fn);
    for (const t of ternaries) for (const [a, b] of [t.cons, t.alt]) if (a <= s && s < b && innermost(ranges, a) === fn) paint(a, s, fn);
  }
  // A block's closing brace runs when its last statement completes normally:
  // that statement's first location was hit and it is not a jump.
  for (const b of blocks) {
    const fn = innermost(ranges, b.open);
    if (b.last === null && !b.isSwitch) continue;
    const inside = (a) => a.fn === fn && a.offset > b.open && a.offset < b.close;
    let ran;
    if (b.isSwitch) ran = at.some((a) => inside(a) && hits.has(a.index)); // a switch's brace runs whenever the switch does
    else {
      // The last statement started: any stop in it (before a nested block) ran,
      // or, when it has none (`break;`), the last stop before it did.
      const nested = blocks.filter((x) => x.open > b.last && x.open < b.close).map((x) => x.open);
      const headEnd = nested.length ? Math.min(...nested) : b.close;
      const own = at.filter((a) => inside(a) && a.offset >= b.last && a.offset < headEnd);
      if (own.length) ran = own.some((a) => hits.has(a.index));
      else { const before = at.filter((a) => inside(a) && a.offset < b.last).at(-1); ran = !!before && hits.has(before.index); }
    }
    if (!ran) continue;
    painted.push([b.close, b.end]);
  }
  painted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of painted) {
    if (e <= s) continue;
    const n = out.length;
    if (n && out[n - 1] >= s) { if (e > out[n - 1]) out[n - 1] = e; } else out.push(s, e);
  }
  return out;
}
