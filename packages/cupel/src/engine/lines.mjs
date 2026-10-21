// Line sets (SPEC 3.1) as sorted interval lists, and per-source line maps. Pure.
//
// A line set is an array of [start, end] pairs: ascending, disjoint and never adjacent. That is
// the canonical form, so `format` gives the report's canonical string directly. Intervals keep
// large ranges cheap: "1-1000000" is one pair, not a million entries.

import { cmp } from './order.mjs';

const RANGE = /^([1-9][0-9]*)(?:-([1-9][0-9]*))?$/;

/**
 * Parses a line-set string. Returns { set, bad, malformed }:
 * `bad` lists ranges with start > end (I3 bad-range), which are left out of `set`;
 * `malformed` is true when the text is not a line set at all.
 */
export function parse(text) {
  if (text === '') return { set: [], bad: [], malformed: false };
  if (typeof text !== 'string') return { set: [], bad: [], malformed: true };
  const ranges = [];
  const bad = [];
  for (const part of text.split(',')) {
    const m = RANGE.exec(part);
    if (!m) return { set: [], bad: [], malformed: true };
    const s = Number(m[1]);
    const e = m[2] === undefined ? s : Number(m[2]);
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e)) return { set: [], bad: [], malformed: true };
    if (e < s) bad.push([s, e]);
    else ranges.push([s, e]);
  }
  return { set: normalize(ranges), bad, malformed: false };
}

/** Parses a line set already known to be valid (bad ranges are dropped). */
export const lines = (text) => parse(text).set;

/** Sorts and merges overlapping or adjacent ranges. */
export function normalize(ranges) {
  const sorted = ranges.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of sorted) append(out, r[0], r[1]);
  return out;
}

function append(out, s, e) {
  const last = out[out.length - 1];
  if (last && s <= last[1] + 1) {
    if (e > last[1]) last[1] = e;
  } else {
    out.push([s, e]);
  }
}

/** The canonical string: ascending, merged, single lines without a range. */
export function format(set) {
  return set.map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(',');
}

export function union(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const r = j >= b.length || (i < a.length && a[i][0] <= b[j][0]) ? a[i++] : b[j++];
    append(out, r[0], r[1]);
  }
  return out;
}

export function diff(a, b) {
  const out = [];
  let j = 0;
  for (const [s0, e] of a) {
    let s = s0;
    while (j < b.length && b[j][1] < s) j++;
    for (let k = j; k < b.length && b[k][0] <= e; k++) {
      if (b[k][0] > s) out.push([s, b[k][0] - 1]);
      s = Math.max(s, b[k][1] + 1);
      if (s > e) break;
    }
    if (s <= e) out.push([s, e]);
  }
  return out;
}

export function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (s <= e) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

export const size = (set) => set.reduce((n, [s, e]) => n + (e - s + 1), 0);

// ---- Line maps: source path -> line set. Only non-empty sets are stored. ----

export const emptyMap = () => new Map();

/** Builds a line map from { source: "line set" }, dropping bad ranges and empty sets. */
export function mapFrom(obj) {
  const out = new Map();
  for (const [src, text] of Object.entries(obj ?? {})) {
    const set = lines(text);
    if (set.length) out.set(src, union(out.get(src) ?? [], set));
  }
  return out;
}

export function mapUnion(a, b) {
  const out = new Map(a);
  for (const [src, set] of b) out.set(src, out.has(src) ? union(out.get(src), set) : set);
  return out;
}

export function mapUnionAll(maps) {
  let out = new Map();
  for (const m of maps) out = mapUnion(out, m);
  return out;
}

export function mapDiff(a, b) {
  const out = new Map();
  for (const [src, set] of a) {
    const rest = b.has(src) ? diff(set, b.get(src)) : set;
    if (rest.length) out.set(src, rest);
  }
  return out;
}

export function mapIntersect(a, b) {
  const out = new Map();
  for (const [src, set] of a) {
    if (!b.has(src)) continue;
    const both = intersect(set, b.get(src));
    if (both.length) out.set(src, both);
  }
  return out;
}

export function mapSize(m) {
  let n = 0;
  for (const set of m.values()) n += size(set);
  return n;
}

export const mapIsEmpty = (m) => m.size === 0;

/** True when every line of `a` is in `b`. */
export const mapSubset = (a, b) => mapIsEmpty(mapDiff(a, b));

/** Keeps only the sources accepted by `keep(source)`. */
export function mapFilter(m, keep) {
  const out = new Map();
  for (const [src, set] of m) if (keep(src)) out.set(src, set);
  return out;
}

/** { source: canonical line set }, sources in code point order, empty sets left out. */
export function mapToObject(m) {
  const out = {};
  for (const src of [...m.keys()].sort(cmp)) out[src] = format(m.get(src));
  return out;
}

/**
 * For each owner, the lines that no other owner holds (a sweep over every source).
 * `owners` is an array of line maps; returns an array of line maps, index for index.
 */
export function exclusiveLines(owners) {
  const result = owners.map(() => new Map());
  const sources = new Set();
  for (const m of owners) for (const src of m.keys()) sources.add(src);
  for (const src of sources) {
    const events = [];
    owners.forEach((m, i) => {
      for (const [s, e] of m.get(src) ?? []) events.push([s, 1, i], [e + 1, -1, i]);
    });
    events.sort((a, b) => a[0] - b[0]);
    let count = 0;
    let sum = 0; // with count === 1, the sum of active owner indexes is the single owner
    let prev = 0;
    for (let k = 0; k < events.length; ) {
      const pos = events[k][0];
      if (count === 1 && pos > prev) {
        const set = result[sum].get(src) ?? [];
        append(set, prev, pos - 1);
        result[sum].set(src, set);
      }
      while (k < events.length && events[k][0] === pos) {
        count += events[k][1];
        sum += events[k][1] * events[k][2];
        k++;
      }
      prev = pos;
    }
  }
  return result;
}
