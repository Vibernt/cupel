// Deterministic ordering helpers (R1). Pure.
//
// Strings are compared by Unicode code point (equivalently, by UTF-8 bytes), not by UTF-16
// code unit, so another implementation in a language with code-point strings sorts the same way.

/** Code point order. Returns a negative number, zero or a positive number. */
export function cmp(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x !== y) {
      if (x >= 0xd800 && y >= 0xd800) {
        // Surrogates (0xD800-0xDFFF) encode code points above 0xFFFF, so they sort after 0xE000-0xFFFF.
        x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
        y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
      }
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** A new array of the distinct strings, sorted by code point. */
export function sortedUnique(values) {
  return [...new Set(values)].sort(cmp);
}

/** Sorts objects by a string key, then by the given tie-breakers. */
export function byKey(key) {
  return (a, b) => cmp(a[key], b[key]);
}
