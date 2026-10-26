import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const ARTIFACT_VERSION = 'cupel-s18-sealed-baseline/1';
export const MAX_ARTIFACT_BYTES = 64 << 20;
const pin = value => /^sha256:[0-9a-f]{64}$/.test(value);
export const rawHash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function writeArtifact(out, artifact, baseRoot) {
  const path = join(out, 'sealed-baseline.json');
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  if (bytes.length > MAX_ARTIFACT_BYTES)
    throw new Error('S18 sealed baseline exceeds 64 MiB artifact limit');
  if (bytes.includes(Buffer.from(baseRoot)))
    throw new Error('sealed baseline contains an absolute baseline-root reference');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { artifactPath: path, artifactHash: rawHash(bytes), artifactBytes: bytes.length };
}

/** Exactly one artifact read per consume request. The pin comes from independent trusted storage. */
export function readArtifact(path, expectedHash) {
  if (!pin(expectedHash)) throw new Error('S18 independent artifact SHA-256 pin required');
  if (basename(path) !== 'sealed-baseline.json')
    throw new Error('S18 artifact path must name sealed-baseline.json');
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('S18 sealed artifact must be a regular file');
  if (stat.size > MAX_ARTIFACT_BYTES)
    throw new Error('S18 sealed artifact exceeds 64 MiB limit');
  const bytes = readFileSync(path);
  if (bytes.length > MAX_ARTIFACT_BYTES)
    throw new Error('S18 sealed artifact exceeds 64 MiB limit');
  if (rawHash(bytes) !== expectedHash) throw new Error('S18 sealed artifact raw SHA-256 differs');
  let artifact;
  try { artifact = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('S18 sealed artifact JSON malformed'); }
  if (artifact?.version !== ARTIFACT_VERSION)
    throw new Error('S18 sealed artifact version differs');
  return artifact;
}
