import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_VERSION, rawHash } from '../artifact.mjs';
import { measureArtifactCost } from './artifact-cost.mjs';

test('artifact cost diagnostic checks the raw pin on every repetition', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-s18-cost-'));
  try {
    const file = join(root, 'sealed-baseline.json');
    const bytes = Buffer.from(JSON.stringify({version:ARTIFACT_VERSION, marker:'test'}) + '\n');
    writeFileSync(file, bytes);
    const result = measureArtifactCost(file, rawHash(bytes), 3);
    assert.equal(result.artifactBytes, bytes.length);
    assert.equal(result.samples.length, 3);
    assert.ok(result.medians.fullReadArtifactMs >= 0);
    assert.throws(() => measureArtifactCost(file, `sha256:${'0'.repeat(64)}`, 1), /raw hash mismatch/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
