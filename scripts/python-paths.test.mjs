import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venvPython } from './python-paths.mjs';

test('virtual-environment Python path follows the host layout', () => {
  assert.equal(venvPython('/tools/runtime', 'linux'), '/tools/runtime/bin/python');
  assert.equal(venvPython('/tools/runtime', 'darwin'), '/tools/runtime/bin/python');
  assert.equal(venvPython('/tools/runtime', 'win32'), '\\tools\\runtime\\Scripts\\python.exe');
  assert.equal(venvPython('D:\\a\\runtime', 'win32'), 'D:\\a\\runtime\\Scripts\\python.exe');
});
