// Deterministic package order for one Go fault. Only collected input and previous
// input influence it; timings measured by this mutation run never do.

import { cmp } from '../engine/order.mjs';

/**
 * Catch-history first, then the foo_test.go package beside foo.go, then most
 * covering tests, collected duration, and package name.
 */
export function orderGoPackages({ packages, previousCatchers = [], packageOfTest = () => undefined,
  nearPackages = [], inputMs = () => 0 }) {
  const known = new Set(packages.keys());
  const placed = new Set();
  const out = [];
  const place = (pkg) => {
    if (!known.has(pkg) || placed.has(pkg)) return;
    placed.add(pkg);
    out.push(pkg);
  };
  const byInput = (a, b) => ((packages.get(b)?.tests.length ?? 0) - (packages.get(a)?.tests.length ?? 0))
    || (inputMs(a) - inputMs(b)) || cmp(a, b);
  for (const id of previousCatchers) place(packageOfTest(id));
  for (const pkg of [...new Set(nearPackages)].filter((p) => known.has(p)).sort(byInput)) place(pkg);
  for (const pkg of [...known].filter((p) => !placed.has(p)).sort(byInput)) place(pkg);
  return out;
}

/** A targeted unit needs every covering package; otherwise one/two catches settle the fault. */
export function shouldStopGo({ catching, firstCatch = false, targeted = false }) {
  return !targeted && catching >= (firstCatch ? 1 : 2);
}
