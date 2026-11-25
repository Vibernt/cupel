export function testPython(env = process.env) {
  return env.CUPEL_TEST_PYTHON ?? '/Users/vid/codecrystal/.venv/bin/python';
}

export const TEST_PYTHON = testPython();
