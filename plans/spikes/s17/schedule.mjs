export const THREE_WAY_METHODS = ['old', 'guards', 'current'];

export function threeWayOrder(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error('invalid pair index');
  return index % 2 === 0 ? [...THREE_WAY_METHODS] : [...THREE_WAY_METHODS].reverse();
}
