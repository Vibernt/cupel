import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pythonTestCommand } from './python-test-command.mjs';

test('Python unittest launcher uses the platform command installed by setup-python', () => {
  assert.equal(pythonTestCommand('win32'), 'python');
  assert.equal(pythonTestCommand('linux'), 'python3');
  assert.equal(pythonTestCommand('darwin'), 'python3');
});
