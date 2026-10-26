export function pairOrder(index, a, b) {
  if (!Number.isInteger(index) || index < 0 || a === b || !a || !b)
    throw new Error('invalid S18 comparison pair');
  return index % 2 === 0 ? [a, b] : [b, a];
}

export function median(values) {
  if (!values.length || values.some(value => !Number.isFinite(value)))
    throw new Error('median needs finite samples');
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

export function amortized(setupMs, requestMs, counts = [1, 10, 100]) {
  if (![setupMs, requestMs].every(value => Number.isFinite(value) && value >= 0))
    throw new Error('invalid amortization costs');
  return Object.fromEntries(counts.map(count => {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid amortization request count');
    return [count, requestMs + setupMs / count];
  }));
}
