export const median = values => {
  if (!Array.isArray(values) || !values.length ||
    values.some(value => !Number.isFinite(value) || value <= 0))
    throw new Error('timing samples must be positive finite values');
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
};

export function alternatingOrder(pair, first, second) {
  if (!Number.isInteger(pair) || pair < 1 || first === second) throw new Error('invalid timing pair');
  return pair % 2 === 1 ? [first, second] : [second, first];
}

export function performanceGate(oldCandidatePairs, candidateFullPairs) {
  if (oldCandidatePairs.length !== 5 || candidateFullPairs.length !== 5)
    throw new Error('five paired samples per comparison are required');
  const check = (pairs, left, right) => pairs.map(pair => {
    if (!Number.isFinite(pair[left]) || pair[left] <= 0 ||
      !Number.isFinite(pair[right]) || pair[right] <= 0)
      throw new Error('invalid paired timing');
    return pair;
  });
  const optimization = check(oldCandidatePairs, 'old', 'candidate');
  const usefulness = check(candidateFullPairs, 'candidate', 'full');
  const oldMedian = median(optimization.map(pair => pair.old));
  const candidateOldMedian = median(optimization.map(pair => pair.candidate));
  const candidateFullMedian = median(usefulness.map(pair => pair.candidate));
  const fullMedian = median(usefulness.map(pair => pair.full));
  const fasterThanOld = optimization.filter(pair => pair.candidate < pair.old).length;
  const fasterThanFull = usefulness.filter(pair => pair.candidate < pair.full).length;
  return { oldMedian, candidateOldMedian, candidateFullMedian, fullMedian,
    fasterThanOld, fasterThanFull,
    optimization: fasterThanOld >= 4 && candidateOldMedian <= oldMedian * 0.8,
    productionUsefulness: fasterThanFull >= 4 && fullMedian - candidateFullMedian >= 10 };
}
