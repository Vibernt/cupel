const { step, other } = require('../src/math.cjs');
let hooks = 0;
beforeEach(() => { hooks = step(1); });
afterEach(() => { hooks = other(2); });

describe('math', () => {
  test.each([1, 2])('step %i', x => { expect(step(x)).toBe(x + 1); });
  test('duplicate', () => { expect(hooks).toBe(2); });
  test('duplicate', () => { expect(hooks).toBe(2); });
  test.concurrent('concurrent one', async () => { await Promise.resolve(); expect(step(3)).toBe(4); });
  test.concurrent('concurrent two', async () => { await Promise.resolve(); expect(other(3)).toBe(6); });
});
