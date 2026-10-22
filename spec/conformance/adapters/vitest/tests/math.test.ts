import { add, cap } from '../src/math'

let hooks = 0
beforeEach(() => { hooks++; cap(-1) })
afterEach(() => { cap(11) })
afterAll(() => { cap(9) })

test('add sums a pair [critical]', () => {
  expect(add({ left: 2, right: 3 })).toBe(5)
})

describe('cap', () => {
  test.each([[-1, 0], [5, 5], [11, 10]])('maps %i to %i', (value, want) => {
    expect(cap(value)).toBe(want)
  })
})
