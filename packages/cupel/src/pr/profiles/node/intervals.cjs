// Positive V8 character intervals. Mirrors the collector's interval rule.
function positiveIntervals(functions) {
  const ranges = [];
  let order = 0;
  for (const fn of functions) for (const r of fn.ranges)
    ranges.push({ s: r.startOffset, e: r.endOffset, c: r.count, o: order++ });
  ranges.sort((x, y) => x.s - y.s || y.e - x.e || x.o - y.o);
  const out = [], stack = [];
  let pos = 0;
  const emit = (a, b, c) => {
    if (b <= a || c <= 0) return;
    const n = out.length;
    if (n && out[n - 1] >= a) { if (b > out[n - 1]) out[n - 1] = b; }
    else out.push(a, b);
  };
  for (const r of ranges) {
    while (stack.length && stack.at(-1).e <= r.s) {
      const top = stack.pop(); emit(pos, top.e, top.c); pos = Math.max(pos, top.e);
    }
    if (stack.length) emit(pos, r.s, stack.at(-1).c);
    pos = Math.max(pos, r.s); stack.push(r);
  }
  while (stack.length) { const top = stack.pop(); emit(pos, top.e, top.c); pos = Math.max(pos, top.e); }
  return out;
}

function unionIntervals(a, b) {
  if (!a?.length) return b ? b.slice() : [];
  if (!b?.length) return a.slice();
  const out = [];
  let i = 0, j = 0;
  const push = (s, e) => {
    const n = out.length;
    if (n && out[n - 1] >= s) { if (e > out[n - 1]) out[n - 1] = e; }
    else out.push(s, e);
  };
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] <= b[j])) { push(a[i], a[i + 1]); i += 2; }
    else { push(b[j], b[j + 1]); j += 2; }
  }
  return out;
}

function addAll(into, add) {
  for (const [path, iv] of add) into.set(path, unionIntervals(into.get(path), iv));
}

module.exports = { positiveIntervals, unionIntervals, addAll };
