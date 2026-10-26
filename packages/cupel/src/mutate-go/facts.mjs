import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { refuse } from './errors.mjs';
import { safeGoName } from './path.mjs';

const CANONICAL = /^sha256:[0-9a-f]{64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    refuse('source-path', `Go source leaves project root: ${path}`);
}

export class GoSourceFacts {
  #root;
  #rootReal;
  #records = new Map();
  #sources = new Set();
  #metrics;

  constructor(root, input, metrics) {
    this.#root = resolve(root);
    this.#rootReal = realpathSync(this.#root);
    this.#metrics = metrics;
    if (!Object.keys(input.sources ?? {}).length) refuse('source-hash', 'Go input has no source hashes');
    const sources = Object.keys(input.sources).sort();
    const tests = [...new Set(input.tests.map((row) => row.file))].sort();
    for (const source of sources) {
      safeGoName(source, false);
      if (!CANONICAL.test(input.sources[source].hash ?? ''))
        refuse('source-hash', `Go input requires canonical sha256 hash for ${source}`);
    }
    for (const file of tests) safeGoName(file, true);
    for (const file of [...sources, ...tests]) this.#validate(file);
    let retained = 0;
    for (const source of sources) {
      const declared = input.sources[source].hash;
      const current = this.#read(source);
      if (current.hash !== declared)
        refuse('source-changed', `Go source hash differs from input: ${source}`);
      retained += current.bytes.length;
      if (retained > MAX_TOTAL_BYTES)
        refuse('source-facts-limit', `Go source facts exceed ${MAX_TOTAL_BYTES} bytes`);
      this.#records.set(source, { ...current, bytes: current.bytes });
      this.#sources.add(source);
    }
    for (const file of tests) {
      if (this.#records.has(file)) refuse('source-path', `Go test file overlaps a production source: ${file}`);
      const current = this.#read(file);
      retained += current.bytes.length;
      if (retained > MAX_TOTAL_BYTES)
        refuse('source-facts-limit', `Go source and test facts exceed ${MAX_TOTAL_BYTES} bytes`);
      this.#records.set(file, { ...current, bytes: current.bytes });
    }
  }

  #validate(source) {
    const logical = resolve(join(this.#root, source));
    inside(this.#root, logical);
    if (realpathSync(this.#root) !== this.#rootReal)
      refuse('source-changed', 'Go project root changed');
    const actual = realpathSync(logical);
    inside(this.#rootReal, actual);
    const stat = lstatSync(logical);
    if (!stat.isFile() || stat.nlink !== 1 || logical !== actual)
      refuse('source-path', `Go source must be a single-link regular file: ${source}`);
    return { logical, actual, stat };
  }

  #read(source) {
    if (constants.O_NOFOLLOW === undefined)
      refuse('source-path', 'safe Go source open is unavailable on this host');
    const { logical, actual, stat } = this.#validate(source);
    const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_BYTES)
        refuse('source-path', `Go source identity or size is unsafe: ${source}`);
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    if (this.#metrics) {
      this.#metrics.sourceReads = (this.#metrics.sourceReads ?? 0) + 1;
      this.#metrics.sourceBytesHashed = (this.#metrics.sourceBytesHashed ?? 0) + bytes.length;
    }
    return { logical, actual, dev: stat.dev, ino: stat.ino, hash: hash(bytes), bytes };
  }

  bytes(source) {
    if (!this.#sources.has(source)) refuse('source-path', `Go mutation source is not a collected production file: ${source}`);
    const record = this.#records.get(source);
    if (!record) refuse('source-path', `Go source is absent from input: ${source}`);
    return record.bytes;
  }

  assertFresh() {
    for (const [source, record] of this.#records) {
      const current = this.#read(source);
      if (current.logical !== record.logical || current.actual !== record.actual ||
          current.dev !== record.dev || current.ino !== record.ino || current.hash !== record.hash)
        refuse('source-changed', `Go source bytes or path changed: ${source}`);
    }
    if (this.#metrics) this.#metrics.sourceChecks = (this.#metrics.sourceChecks ?? 0) + 1;
  }
}
