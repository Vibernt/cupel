// Order in which a fault's covering test targets run (Rust, first-catch mode).
//
// Targets holding a test that caught this fault in an earlier run go first, so the
// catch is usually found by the first target. Next come targets holding a test written
// in the fault's own source file (a module's unit tests usually catch its faults, and
// broad integration suites, which cover everything, are slow). The rest keep the rule
// that needs only the inputs: most covering tests first, then the input's durations,
// then the key. Order only decides which targets run before the stop rule ends a
// fault, so it can change which tests are credited, never whether a fault is caught.
//
// Pure: no I/O, no node: imports.

import { cmp } from '../engine/order.mjs';

/**
 * @param {{
 *   keys: string[],
 *   namesByKey: Map<string, Set<string>>,
 *   inputMs: (key: string) => number,
 *   previousCatchers?: string[],
 *   keyOfTest?: (testId: string) => string | undefined,
 *   nearKeys?: Iterable<string>,
 * }} args
 * @returns {string[]} a permutation of the distinct `keys`
 */
export function orderTargets({ keys, namesByKey, inputMs, previousCatchers = [], keyOfTest = () => undefined, nearKeys = [] }) {
  const known = new Set(keys);
  const out = [];
  const placed = new Set();
  const place = (key) => {
    if (!known.has(key) || placed.has(key)) return;
    placed.add(key);
    out.push(key);
  };
  const byInput = (a, b) => ((namesByKey.get(b)?.size ?? 0) - (namesByKey.get(a)?.size ?? 0)) || (inputMs(a) - inputMs(b)) || cmp(a, b);
  for (const id of previousCatchers) place(keyOfTest(id));
  for (const key of [...new Set(nearKeys)].filter((k) => known.has(k)).sort(byInput)) place(key);
  for (const key of [...known].filter((k) => !placed.has(k)).sort(byInput)) place(key);
  return out;
}
