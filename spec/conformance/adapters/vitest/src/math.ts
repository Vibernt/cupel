export interface Pair {
  left: number
  right: number
}
export type Mode = 'add' | 'cap'

export function add(pair: Pair): number {
  return pair.left + pair.right
}

export function cap(n: number): number {
  if (n < 0) return 0
  if (n > 10) return 10
  return n
}
