import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ARTIFACT_BYTES, readArtifact, writeArtifact } from './artifact.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/s18/tests/', import.meta.url));
mkdirSync(scratch, { recursive: true });
const unique = prefix => mkdtempSync(join(scratch, prefix));
const zero = `sha256:${'0'.repeat(64)}`;

test('S18 artifact writer refuses baseline-root references and existing outputs', () => {
  const out = unique('artifact-write-');
  assert.throws(() => writeArtifact(out, { version: 'x', path: '/baseline/root' },
    '/baseline/root'), /baseline-root reference/);
  const created = writeArtifact(out, { version: 'x' }, '/baseline/root');
  assert.equal(created.artifactPath, join(out, 'sealed-baseline.json'));
  assert.throws(() => writeArtifact(out, { version: 'x' }, '/baseline/root'), /EEXIST/);
});

test('S18 artifact reader refuses wrong name, symlink and oversized file before reading', () => {
  const out = unique('artifact-read-');
  const wrong = join(out, 'credentials.json');
  writeFileSync(wrong, '{}\n');
  assert.throws(() => readArtifact(wrong, zero), /must name sealed-baseline.json/);
  const linked = join(unique('artifact-link-'), 'sealed-baseline.json');
  symlinkSync(wrong, linked);
  assert.throws(() => readArtifact(linked, zero), /regular file/);
  const large = join(unique('artifact-large-'), 'sealed-baseline.json');
  writeFileSync(large, '');
  truncateSync(large, MAX_ARTIFACT_BYTES + 1);
  assert.throws(() => readArtifact(large, zero), /64 MiB limit/);
});
