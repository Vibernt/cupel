// Explicit, historical report snapshots for one local MCP server process.
// This stores report output only. It is not an input/evidence cache for guard.
import { createHash } from 'node:crypto';

const VERSION = 'cupel-report-snapshot/1';
const PREFIX = 'r1';
const MAX_ENTRIES = 8;
const MAX_BYTES = 32 * 1024 * 1024;
const ID = /^r1\.([0-9a-f]{64})\.([0-9a-f]{64})$/;
const digest = text => createHash('sha256').update(text).digest('hex');

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

/** A root-bound LRU. Values are serialized JSON, never references to caller objects. */
export class ReportSnapshots {
  constructor(root, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
    if (typeof root !== 'string' || !root || !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid report snapshot bounds');
    this.root = root;
    this.rootDigest = digest(root);
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.totalBytes = 0;
    this.sequence = 0;
  }

  // A corrupted public entry must never turn totalBytes into NaN or disable a
  // bound. Refuse further cache work until this server process ends.
  assertAccounting() {
    const bad = () => { throw new SnapshotError('integrity', 'report snapshot cache accounting integrity check failed'); };
    if (!(this.entries instanceof Map) || !Number.isSafeInteger(this.totalBytes) || this.totalBytes < 0 ||
        this.totalBytes > this.maxBytes || this.entries.size > this.maxEntries ||
        !Number.isSafeInteger(this.sequence) || this.sequence < 0) bad();
    let counted = 0;
    for (const entry of this.entries.values()) {
      if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
          !Number.isSafeInteger(entry.lastUse) || entry.lastUse < 1 || entry.lastUse > this.sequence) bad();
      counted += entry.bytes;
    }
    if (!Number.isSafeInteger(counted) || counted !== this.totalBytes) bad();
  }

  nextUse() {
    if (!Number.isSafeInteger(this.sequence + 1)) throw new SnapshotError('sequence-exhausted', 'report snapshot use counter exhausted');
    return ++this.sequence;
  }

  put(report, exit) {
    this.assertAccounting();
    if ((exit !== 0 && exit !== 1) || report === null || typeof report !== 'object' || Array.isArray(report)) {
      throw new SnapshotError('not-retainable', 'only a completed report with exit 0 or 1 can be retained');
    }
    let serialized;
    try { serialized = JSON.stringify({ version: VERSION, root: this.root, report, exit }); }
    catch { throw new SnapshotError('not-serializable', 'report snapshot is not JSON serializable'); }
    if (typeof serialized !== 'string') throw new SnapshotError('not-serializable', 'report snapshot is not JSON serializable');
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxBytes) throw new SnapshotError('too-large', `report snapshot is too large (${bytes} UTF-8 bytes; limit ${this.maxBytes})`);
    const id = `${PREFIX}.${this.rootDigest}.${digest(serialized)}`;
    const old = this.entries.get(id);
    if (old) {
      if (old.serialized !== serialized || old.bytes !== bytes) throw new SnapshotError('integrity', 'report snapshot integrity check failed');
      old.lastUse = this.nextUse();
      return id;
    }
    while (this.entries.size >= this.maxEntries || this.totalBytes + bytes > this.maxBytes) this.evictOldest();
    this.entries.set(id, { serialized, bytes, lastUse: this.nextUse() });
    this.totalBytes += bytes;
    return id;
  }

  get(id, root) {
    this.assertAccounting();
    const match = typeof id === 'string' ? ID.exec(id) : null;
    if (!match) throw new SnapshotError('invalid-id', 'invalid report snapshotId');
    if (root !== this.root || match[1] !== this.rootDigest) {
      throw new SnapshotError('wrong-root', 'report snapshot belongs to another repository root');
    }
    const entry = this.entries.get(id);
    if (!entry) throw new SnapshotError('missing', 'report snapshot is missing or evicted from this server process');
    if (typeof entry.serialized !== 'string' || !Number.isSafeInteger(entry.bytes) ||
        entry.bytes !== Buffer.byteLength(entry.serialized, 'utf8') || digest(entry.serialized) !== match[2]) {
      this.remove(id);
      throw new SnapshotError('integrity', 'report snapshot integrity check failed');
    }
    let value;
    try { value = JSON.parse(entry.serialized); }
    catch {
      this.remove(id);
      throw new SnapshotError('integrity', 'report snapshot integrity check failed');
    }
    if (value.version !== VERSION || value.root !== this.root || ![0, 1].includes(value.exit) ||
        value.report === null || typeof value.report !== 'object' || Array.isArray(value.report)) {
      this.remove(id);
      throw new SnapshotError('integrity', 'report snapshot integrity check failed');
    }
    entry.lastUse = this.nextUse();
    return { report: value.report, exit: value.exit };
  }

  remove(id) {
    this.assertAccounting();
    const entry = this.entries.get(id);
    if (entry) this.totalBytes -= entry.bytes;
    this.entries.delete(id);
  }

  evictOldest() {
    this.assertAccounting();
    let oldestId;
    let oldestUse = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.lastUse < oldestUse) { oldestId = id; oldestUse = entry.lastUse; }
    }
    if (oldestId === undefined) throw new SnapshotError('integrity', 'report snapshot cache accounting failed');
    this.remove(oldestId);
  }
}
