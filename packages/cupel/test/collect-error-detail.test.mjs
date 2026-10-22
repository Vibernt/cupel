import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectorError } from '../src/collect/error-detail.mjs';

test('collector error gives a bounded first line and persists full detail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cupel-error-test-'));
  try {
    const detail = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ test: i })));
    const message = collectorError(`failed: ${detail}\nignored`, detail, dir);
    assert.ok(message.length < 600);
    assert.match(message, /^failed:/);
    assert.equal(readFileSync(join(dir, 'collector-error.txt'), 'utf8'), detail);
    assert.match(message, /full detail:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
