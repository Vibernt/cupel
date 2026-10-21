// Conformance matching (spec/SPEC.md section 16). Pure.
// Objects match on the keys the expected value lists; arrays match element by element with equal length;
// other values must be equal; the string "$absent" means the key must not be present.

export const ABSENT = '$absent';

/** Returns a list of mismatch descriptions, empty when `actual` matches `expected`. */
export function match(expected, actual, path = '') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path || '/'}: expected an array, got ${JSON.stringify(actual)}`];
    if (actual.length !== expected.length) {
      return [`${path || '/'}: expected ${expected.length} items, got ${actual.length}: ${JSON.stringify(actual)}`];
    }
    return expected.flatMap((e, i) => match(e, actual[i], `${path}/${i}`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${path || '/'}: expected an object, got ${JSON.stringify(actual)}`];
    }
    return Object.entries(expected).flatMap(([k, e]) => {
      const p = `${path}/${k}`;
      if (e === ABSENT) return Object.hasOwn(actual, k) ? [`${p}: expected to be absent, got ${JSON.stringify(actual[k])}`] : [];
      if (!Object.hasOwn(actual, k)) return [`${p}: missing`];
      return match(e, actual[k], p);
    });
  }
  return Object.is(expected, actual) ? [] : [`${path || '/'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}
