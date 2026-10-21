// Character intervals for V8 coverage (K1). Used inside the test processes by hook.mjs, and by the collector.
//
// V8 reports nested ranges per function. A character's count is the count of the innermost range that holds
// it (ranges are painted widest first). This module keeps only what the line rule needs: the half-open
// character intervals [start, end) whose count is above 0, as a flat sorted array [s0, e0, s1, e1, ...].
// The union of two entries' positive intervals gives exactly the lines that either entry covers, so entries
// can be united here, before the line rule runs once per source in the collector.
//
// Ported from spike S2 (plans/spikes/s2/lines.mjs, `flatten`). Standard library only.

/** Positive intervals of one script's functions (a V8 ScriptCoverage `functions` array), merged and sorted. */
export function positiveIntervals(functions) {
  const ranges = [];
  let order = 0;
  for (const fn of functions) for (const r of fn.ranges) ranges.push({ s: r.startOffset, e: r.endOffset, c: r.count, o: order++ });
  // Widest first: by start, then longer first, then V8's order (a later range with the same extent wins).
  ranges.sort((x, y) => x.s - y.s || y.e - x.e || x.o - y.o);
  const out = [];
  const stack = [];
  let pos = 0;
  const emit = (a, b, c) => {
    if (b <= a || c <= 0) return;
    const n = out.length;
    if (n && out[n - 1] >= a) { if (b > out[n - 1]) out[n - 1] = b; } else out.push(a, b);
  };
  for (const r of ranges) {
    while (stack.length && stack[stack.length - 1].e <= r.s) {
      const top = stack.pop();
      emit(pos, top.e, top.c);
      pos = Math.max(pos, top.e);
    }
    if (stack.length) emit(pos, r.s, stack[stack.length - 1].c);
    pos = Math.max(pos, r.s);
    stack.push(r);
  }
  while (stack.length) {
    const top = stack.pop();
    emit(pos, top.e, top.c);
    pos = Math.max(pos, top.e);
  }
  return out;
}

/** Union of two flat sorted interval arrays. */
export function unionIntervals(a, b) {
  if (!a || !a.length) return b ? b.slice() : [];
  if (!b || !b.length) return a.slice();
  const out = [];
  let i = 0, j = 0;
  const push = (s, e) => {
    const n = out.length;
    if (n && out[n - 1] >= s) { if (e > out[n - 1]) out[n - 1] = e; } else out.push(s, e);
  };
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] <= b[j])) { push(a[i], a[i + 1]); i += 2; } else { push(b[j], b[j + 1]); j += 2; }
  }
  return out;
}

/** Adds `add` (a { path: intervals } object or Map) into the Map `into`. */
export function addAll(into, add) {
  const entries = add instanceof Map ? add.entries() : Object.entries(add);
  for (const [path, iv] of entries) into.set(path, unionIntervals(into.get(path), iv));
  return into;
}
