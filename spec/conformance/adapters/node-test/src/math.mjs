// Small module for the node:test adapter fixture.
export const VERSION = 1;

export function add(a, b) {
  return a + b;
}

export function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

export function unused() {
  return 'never called';
}
