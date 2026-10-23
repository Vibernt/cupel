import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFor } from './runtime.mjs';

test('collector runtime names match Go and Ruby collectors', () => {
  assert.equal(runtimeFor.go, 'go');
  assert.equal(runtimeFor.minitest, 'ruby');
});
