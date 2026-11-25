import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPython } from './python-paths.mjs';
import { vitestModulePaths } from './vitest-paths.mjs';

test('hosted fixture paths override the unchanged maintainer defaults', () => {
  assert.equal(testPython({}), '/Users/vid/codecrystal/.venv/bin/python');
  assert.equal(testPython({ CUPEL_TEST_PYTHON: '/ci/python' }), '/ci/python');
  assert.deepEqual(vitestModulePaths({}), {
    v4: '/Users/vid/codecrystal/hub-ts/node_modules',
    v5: '/Users/vid/codecrystal/web/node_modules',
  });
  assert.deepEqual(vitestModulePaths({
    CUPEL_TEST_VITEST4_MODULES: '/ci/v4', CUPEL_TEST_VITEST5_MODULES: '/ci/v5',
  }), { v4: '/ci/v4', v5: '/ci/v5' });
});
