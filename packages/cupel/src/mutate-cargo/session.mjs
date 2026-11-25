// Persistent build sessions for Cupel's own Rust fault runner (`backend: "cupel"`).
//
// A session is `<project>/.scratch/cupel-rust-sessions/<sessionId>/{project,target,meta.json,sync.json,lock}`.
// `project` is a byte-identical copy of the assessed project (the same skips and links as copyProject),
// brought up to date before every use; `target` keeps its build between runs; `meta.json` keeps the
// unmutated test passes of the last runs (see fast.mjs) so a later run can reuse them.
//
// The sessionId covers what changes how Rust builds, never the sources (they change on every commit).
// Nothing here writes the assessed project.

import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CargoMutantsError } from './import.mjs';

export const DEFAULT_CAP_GB = 10;
const SKIP = new Set(['.git', '.cupel', '.scratch', 'target']); // as copyProject
const META_VERSION = 1;
const GB = 1024 ** 3;

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** Writes a file whole or not at all. */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const stable = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

export const sessionsRoot = (root) => join(root, '.scratch', 'cupel-rust-sessions');

/**
 * The session id: sha256 over the project's real path, the Rust toolchain (rustc -vV, cargo version, host),
 * the Rust flags Cupel builds with, the cargo runner config without `mutants`, and Cupel's version.
 */
export function sessionId({ root, rustc = '', cargo = '', host = '', rustflags = '', encodedRustflags = '', runner = {}, version = '' }) {
  const { mutants: _mutants, ...config } = runner ?? {};
  return createHash('sha256').update(stable({ root: realpathSync(root), rustc, cargo, host, rustflags, encodedRustflags, config, version })).digest('hex').slice(0, 32);
}

/** The SHA-256 of a file, read in chunks. */
export function hashFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0; n = readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

// ---- lock ----

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Whether a lock file names a running process. A lock that cannot be read yet is held, unless it is old. */
export function lockHeld(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  let info = null;
  try { info = JSON.parse(text); } catch { info = null; }
  if (!info || !Number.isInteger(info.pid)) {
    try { return Date.now() - statSync(path).mtimeMs < 10_000; } catch { return false; }
  }
  return alive(info.pid);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the exclusive lock of a session: a file made only if absent, holding the pid and start time.
 * Waits up to waitMs for a running holder, then refuses; a lock whose process is gone is taken over.
 * Returns a release function.
 */
export async function acquireLock(path, { waitMs = 5000, pollMs = 100 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  for (;;) {
    try {
      writeFileSync(path, mine, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (!lockHeld(path)) { try { unlinkSync(path); } catch { /* another run took it over first */ } continue; }
    if (Date.now() >= deadline) {
      const info = readJson(path);
      throw new CargoMutantsError(`another Cupel Rust run is using this build session (pid ${info?.pid ?? '?'}${info?.started ? `, started ${info.started}` : ''}); waited ${Math.round(waitMs / 1000)}s. Wait for it to finish, or set runners.cargo.mutants.session to false for a throwaway copy`);
    }
    await sleep(pollMs);
  }
  const release = () => {
    process.removeListener('exit', release);
    try { if (readJson(path)?.pid === process.pid) unlinkSync(path); } catch { /* gone */ }
  };
  process.once('exit', release);
  return release;
}

// ---- sync ----

const sameMode = (a, b) => (a.mode & 0o777) === (b.mode & 0o777);

function sameContent(a, b) {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

/**
 * Makes `dest` the project the way copyProject does (same skips; node_modules folders linked; symbolic links
 * copied as links) while copying only what changed since the last sync and deleting what no longer exists.
 * `manifestFile` remembers each file's size and mtime at both ends; a file whose stat differs is compared
 * byte for byte and copied (new mtime, so Cargo rebuilds what it feeds) when it differs. A file a crashed
 * run left modified in `dest` therefore always comes back. `root` is only read.
 */
export function syncProject(root, dest, manifestFile) {
  const old = readJson(manifestFile)?.files ?? {};
  const files = {};
  const counts = { copied: 0, deleted: 0, unchanged: 0 };
  mkdirSync(dest, { recursive: true });
  const remove = (path) => { rmSync(path, { recursive: true, force: true }); counts.deleted++; };
  const walk = (from, to, rel) => {
    const entries = readdirSync(from, { withFileTypes: true }).filter((e) => !SKIP.has(e.name));
    const names = new Set(entries.map((e) => e.name));
    for (const name of readdirSync(to)) if (!names.has(name)) remove(join(to, name));
    for (const e of entries) {
      const src = join(from, e.name); const dst = join(to, e.name); const path = rel ? `${rel}/${e.name}` : e.name;
      const d = lstatSync(dst, { throwIfNoEntry: false });
      const link = (target) => {
        if (d?.isSymbolicLink() && readlinkSync(dst) === target) { counts.unchanged++; return; }
        if (d) remove(dst);
        symlinkSync(target, dst, e.name === 'node_modules' ? 'junction' : undefined);
        counts.copied++;
      };
      if (e.name === 'node_modules' && e.isDirectory()) link(src);
      else if (e.isSymbolicLink()) link(readlinkSync(src));
      else if (e.isDirectory()) {
        if (d && !d.isDirectory()) remove(dst);
        else if (d?.isSymbolicLink()) remove(dst);
        if (!lstatSync(dst, { throwIfNoEntry: false })) mkdirSync(dst);
        walk(src, dst, path);
      } else if (e.isFile()) {
        const s = lstatSync(src);
        const rec = old[path];
        let current = d?.isFile() ? d : null;
        const fresh = current && rec && rec.size === s.size && rec.sm === s.mtimeMs && rec.dsize === current.size && rec.dm === current.mtimeMs && sameMode(s, current);
        if (current && !fresh && !(current.size === s.size && sameContent(src, dst))) current = null;
        if (current) {
          if (!sameMode(s, current)) chmodSync(dst, s.mode & 0o777);
          counts.unchanged++;
        } else {
          if (d) rmSync(dst, { recursive: true, force: true });
          copyFileSync(src, dst);
          counts.copied++;
        }
        const dd = lstatSync(dst);
        files[path] = { size: s.size, sm: s.mtimeMs, dsize: dd.size, dm: dd.mtimeMs };
      }
    }
  };
  walk(root, dest, '');
  writeAtomic(manifestFile, `${JSON.stringify({ files })}\n`);
  return { ...counts, project: realpathSync(dest) };
}

// ---- sessions ----

const emptyMeta = (id) => ({ version: META_VERSION, sessionId: id, lastUsed: 0, baselines: {}, switched: {} });

/**
 * Opens (creating it if needed) and locks the session `id` of a project, then syncs its project copy.
 * Returns { dir, project, target, warm, meta, save(), release() }. `warm` is true when the session was
 * used before (its meta is kept; meta of any other session id is never read).
 */
export async function openSession({ root, id, waitMs, pollMs, now = () => Date.now() }) {
  const dir = join(sessionsRoot(root), id);
  mkdirSync(dir, { recursive: true });
  const release = await acquireLock(join(dir, 'lock'), { waitMs, pollMs });
  try {
    const stored = readJson(join(dir, 'meta.json'));
    const usable = stored?.version === META_VERSION && stored.sessionId === id && existsSync(join(dir, 'project'));
    const warm = Boolean(usable && existsSync(join(dir, 'target')));
    const meta = usable ? { ...emptyMeta(id), ...stored } : emptyMeta(id);
    if (!usable) rmSync(join(dir, 'target'), { recursive: true, force: true }); // a target without its meta was built for who knows what
    meta.lastUsed = now();
    mkdirSync(join(dir, 'target'), { recursive: true });
    const synced = syncProject(root, join(dir, 'project'), join(dir, 'sync.json'));
    const session = {
      dir, project: synced.project, target: join(dir, 'target'), warm, meta, sync: synced, release,
      save() { writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`); },
    };
    session.save();
    return session;
  } catch (e) { release(); throw e; }
}

/** Total size in bytes of a folder (symbolic links are not followed). */
export function folderSize(path) {
  let total = 0;
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  for (const name of readdirSync(path)) total += folderSize(join(path, name));
  return total;
}

function listSessions(root) {
  const base = sessionsRoot(root);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const dir = join(base, e.name);
    return { id: e.name, dir, lastUsed: readJson(join(dir, 'meta.json'))?.lastUsed ?? 0, bytes: folderSize(dir), locked: lockHeld(join(dir, 'lock')) };
  });
}

/**
 * Removes the least recently used sessions until all together fit under the cap. The session named by
 * `keep` and any locked session are never removed. Returns { removed: [ids], bytes: total after }.
 */
export function enforceCap(root, { capBytes = DEFAULT_CAP_GB * GB, keep = null } = {}) {
  const all = listSessions(root);
  let total = all.reduce((a, s) => a + s.bytes, 0);
  const removed = [];
  for (const s of all.filter((x) => x.id !== keep && !x.locked).sort((a, b) => (a.lastUsed - b.lastUsed) || (a.id < b.id ? -1 : 1))) {
    if (total <= capBytes) break;
    rmSync(s.dir, { recursive: true, force: true });
    total -= s.bytes;
    removed.push(s.id);
  }
  return { removed, bytes: total };
}

/** `cupel clean --rust-sessions`: removes every session that is not in use. */
export function cleanSessions(root) {
  const all = listSessions(root);
  const removed = []; const busy = [];
  let bytes = 0;
  for (const s of all) {
    if (s.locked) { busy.push(s.id); continue; }
    rmSync(s.dir, { recursive: true, force: true });
    removed.push(s.id); bytes += s.bytes;
  }
  try { if (!readdirSync(sessionsRoot(root)).length) rmSync(sessionsRoot(root), { recursive: true, force: true }); } catch { /* none */ }
  return { removed, busy, bytes };
}
