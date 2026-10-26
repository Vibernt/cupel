// Source facts live for one mutation or confirmation request only. They never cache test outcomes.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnvironmentError } from './runner.mjs';
import { sourcePath, UnsafeSourcePathError } from './source-path.mjs';

export const MAX_SOURCE_FACT_BYTES = 32 * 1024 * 1024;
const CANONICAL_HASH = /^sha256:[0-9a-f]{64}$/;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export class SourceChangedError extends EnvironmentError {
  constructor(source, reason) {
    super(`mutation source changed: ${source}: ${reason}`);
    this.name = 'SourceChangedError';
    this.code = 'source-changed';
  }
}

export class SourceFactsLimitError extends EnvironmentError {
  constructor(source, bytes) {
    super(`mutation source facts exceed ${MAX_SOURCE_FACT_BYTES} retained bytes at ${source} (${bytes} bytes)`);
    this.name = 'SourceFactsLimitError';
    this.code = 'source-facts-limit';
  }
}

/** A bounded, private text and byte-identity ledger for one request. */
export class SourceFacts {
  #root;
  #rootReal;
  #declared;
  #records = new Map();
  #issued = new WeakMap();
  #retainedBytes = 0;
  #metrics;

  constructor(root, input, metrics) {
    this.#root = resolve(root);
    this.#rootReal = realpathSync(this.#root);
    this.#declared = new Map(Object.entries(input.sources ?? {})
      .map(([source, value]) => [source, value?.hash]));
    for (const [source, hash] of this.#declared)
      if (hash !== undefined && !CANONICAL_HASH.test(hash))
        throw new SourceChangedError(source, 'declared input hash is opaque or noncanonical');
    this.#metrics = metrics;
  }

  get retainedBytes() { return this.#retainedBytes; }
  get size() { return this.#records.size; }

  #read(source) {
    let path;
    try { path = sourcePath(this.#root, this.#rootReal, source); }
    catch (error) {
      if (error instanceof UnsafeSourcePathError)
        throw new SourceChangedError(source, `refused before reading source: ${error.message}`);
      throw error;
    }
    if (constants.O_NOFOLLOW === undefined)
      throw new SourceChangedError(source, 'safe source open is unavailable on this host');
    const fd = openSync(path.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== path.device || opened.ino !== path.inode)
        throw new SourceChangedError(source, 'source identity changed before its content read');
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    if (this.#metrics) {
      this.#metrics.sourceReads = (this.#metrics.sourceReads ?? 0) + 1;
      this.#metrics.sourceBytesHashed = (this.#metrics.sourceBytesHashed ?? 0) + bytes.length;
    }
    return { ...path, bytes, hash: sha(bytes) };
  }

  /** Read at enumeration; retain only if a supported in-scope site survives parse validation. */
  readInitial(source) {
    if (!this.#declared.has(source))
      throw new SourceChangedError(source, 'source is absent from the current input');
    const { bytes, ...path } = this.#read(source);
    const initial = Object.freeze({ ...path, source, text: bytes.toString('utf8') });
    this.#issued.set(initial, source);
    return initial;
  }

  retain(source, initial) {
    if (this.#records.has(source)) throw new TypeError(`duplicate mutation source fact: ${source}`);
    if (this.#issued.get(initial) !== source)
      throw new SourceChangedError(source, 'source fact was not issued for this request and path');
    const declared = this.#declared.get(source);
    if (declared !== undefined && (!CANONICAL_HASH.test(declared) || declared !== initial.hash))
      throw new SourceChangedError(source, 'declared input hash is opaque or differs from current bytes');
    const payload = Buffer.byteLength(initial.text, 'utf8');
    if (this.#retainedBytes + payload > MAX_SOURCE_FACT_BYTES)
      throw new SourceFactsLimitError(source, this.#retainedBytes + payload);
    const current = this.#read(source);
    if (current.rootReal !== this.#rootReal || current.logicalPath !== initial.logicalPath ||
      current.realPath !== initial.realPath || current.device !== initial.device ||
      current.inode !== initial.inode || current.hash !== initial.hash)
      throw new SourceChangedError(source, 'bytes or path changed during enumeration');
    this.#records.set(source, Object.freeze({ text: initial.text, hash: initial.hash,
      logicalPath: initial.logicalPath, realPath: initial.realPath,
      device: initial.device, inode: initial.inode, bytes: payload }));
    this.#issued.delete(initial);
    this.#retainedBytes += payload;
    if (this.#metrics) {
      this.#metrics.factSources = this.#records.size;
      this.#metrics.factBytes = this.#retainedBytes;
    }
  }

  assertFresh(source) {
    const fact = this.#records.get(source);
    if (!fact) throw new SourceChangedError(source, 'accepted source fact is missing');
    let current;
    try { current = this.#read(source); }
    catch (error) {
      if (error instanceof SourceChangedError) throw error;
      throw new SourceChangedError(source, `source cannot be read: ${error.message}`);
    }
    if (this.#metrics) this.#metrics.sourceChecks = (this.#metrics.sourceChecks ?? 0) + 1;
    if (current.rootReal !== this.#rootReal || current.logicalPath !== fact.logicalPath ||
      current.realPath !== fact.realPath || current.device !== fact.device ||
      current.inode !== fact.inode || current.hash !== fact.hash)
      throw new SourceChangedError(source, 'bytes, path or retained fact differs');
    return fact.text;
  }

  assertAllFresh() {
    for (const source of this.#records.keys()) this.assertFresh(source);
  }
}
