// Exact ratios and comparisons (R2, A9, A10, G4, G5). Pure. No float ever decides a comparison.

/** floor(10000 × part / whole) / 100, or null when whole is 0 (R2). */
export function pct(part, whole) {
  if (whole === 0) return null;
  const q = (10000n * BigInt(part)) / BigInt(whole); // BigInt division truncates; both are >= 0
  return Number(q) / 100;
}

/** { covered, coverable, pct } */
export const coverageRatio = (covered, coverable) => ({ covered, coverable, pct: pct(covered, coverable) });

/** { detected, undetected, score } */
export const mutationScore = (detected, undetected) => ({ detected, undetected, score: pct(detected, detected + undetected) });

/**
 * The exact rational value of a JSON number, read from its shortest round-trip decimal form,
 * so a threshold written as 0.8 means 8/10 and not the binary double nearest to it.
 * Returns [numerator, denominator] as BigInts, denominator > 0.
 */
export function decimal(x) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(x));
  if (!m) throw new Error(`not a finite number: ${x}`);
  const [, sign, int, frac = '', exp = '0'] = m;
  let num = BigInt(int + frac);
  let den = 10n ** BigInt(frac.length);
  const e = Number(exp);
  if (e >= 0) num *= 10n ** BigInt(e);
  else den *= 10n ** BigInt(-e);
  return [sign ? -num : num, den];
}

/** part / whole >= threshold, exactly. With whole 0 the ratio counts as 0. */
export function ratioAtLeast(part, whole, threshold) {
  const [n, d] = decimal(threshold);
  if (whole === 0) return 0n >= n;
  return BigInt(part) * d >= n * BigInt(whole);
}

/** a/b >= c/d for non-negative integers with b, d > 0. */
export const fracAtLeast = (a, b, c, d) => BigInt(a) * BigInt(d) >= BigInt(c) * BigInt(b);
