// Persistent build sessions for Cupel's own Rust fault runner (`backend: "cupel"`).
//
// A session is `<cache>/rust-sessions/<sessionId>/{project,target,meta.json,sync.json,lock}`, where <cache> is the
// per-user cache folder (cacheDir), never inside the assessed project.
// `project` is a byte-identical copy of the assessed project (the same skips and links as copyProject),
// brought up to date before every use; `target` keeps its build between runs; `meta.json` keeps the
// unmutated test passes of the last runs (see fast.mjs) so a later run can reuse them.
//
// The sessionId covers what changes how Rust builds, never the sources (they change on every commit).
// Nothing here writes the assessed project.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

/** The per-user cache folder: CUPEL_CACHE_DIR, else $XDG_CACHE_HOME/cupel, else the platform's usual place. */
export function cacheDir(env = process.env) {
  if (env.CUPEL_CACHE_DIR) return env.CUPEL_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'cupel');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'cupel');
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'cupel');
  return join(homedir(), '.cache', 'cupel');
}

export const sessionsRoot = (env = process.env) => join(cacheDir(env), 'rust-sessions');

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

/** The releasing function of a lock held under `token`: removes the file only while it still names that token. */
function releaser(path, token) {
  const release = () => {
    process.removeListener('exit', release);
    try { if (readJson(path)?.token === token) unlinkSync(path); } catch { /* gone */ }
  };
  process.once('exit', release);
  return release;
}

/**
 * One attempt to take a lock: exclusive create (`wx`) of a file holding a unique token, the pid and the start
 * time; a live lock is never touched. A lock whose process is gone is reclaimed in two phases: the contender
 * first creates `<lock>.break` with `wx` (only one breaker at a time; a breaker of a dead process older than
 * 30 s is removed), re-reads the lock and confirms it is still the very stale text it judged, unlinks it
 * (nobody else can create the lock meanwhile: the stale file is in the way of every `wx`), creates the new lock
 * with `wx` and removes the breaker. After creating, the token is read back. Returns { release } when held,
 * { held: true } when a running process holds it (or another run is breaking it), { missing: true } without
 * the folder, or { retry: true }. `hooks.afterJudge` runs between judging and breaking (tests).
 */
function tryLockOnce(path, hooks = {}) {
  const token = randomUUID();
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString(), token });
  const create = () => {
    writeFileSync(path, mine, { flag: 'wx' });
    return readJson(path)?.token === token ? { release: releaser(path, token) } : { retry: true };
  };
  try { return create(); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    if (e.code !== 'EEXIST') throw e;
  }
  let judged;
  try { judged = readFileSync(path, 'utf8'); } catch { return { retry: true }; }
  if (lockHeld(path)) return { held: true };
  hooks.afterJudge?.();
  const breaker = `${path}.break`;
  try { writeFileSync(breaker, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' }); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    if (e.code !== 'EEXIST') throw e;
    const info = readJson(breaker);
    const old = (() => { try { return Date.now() - statSync(breaker).mtimeMs > 30_000; } catch { return false; } })();
    if (old && !(Number.isInteger(info?.pid) && alive(info.pid))) { try { unlinkSync(breaker); } catch { /* another run removed it */ } return { retry: true }; }
    return { held: true }; // another run is breaking it
  }
  try {
    let again = null;
    try { again = readFileSync(path, 'utf8'); } catch { /* gone */ }
    if (again !== null && again !== judged) return { retry: true }; // a live run took the place
    if (again !== null) unlinkSync(path);
    try { return create(); } catch (e) { if (e.code === 'EEXIST') return { retry: true }; throw e; }
  } finally { try { unlinkSync(breaker); } catch { /* gone */ } }
}

/**
 * Takes the lock of a session without waiting: a release function, or null when a running process holds it
 * (or the folder does not exist). Used by eviction and clean.
 */
export function tryAcquireLock(path, hooks) {
  for (let i = 0; i < 20; i++) {
    const r = tryLockOnce(path, hooks);
    if (r.release) return r.release;
    if (r.held || r.missing) return null;
  }
  return null;
}

/**
 * Takes the exclusive lock of a session (see tryLockOnce). Waits up to waitMs for a running holder, then
 * refuses; a lock whose process is gone is taken over. Returns a release function.
 */
export async function acquireLock(path, { waitMs = 5000, pollMs = 100, hooks } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = tryLockOnce(path, hooks);
    if (r.release) return r.release;
    if (r.missing) { mkdirSync(dirname(path), { recursive: true }); continue; } // the folder was removed meanwhile
    if (r.held) {
      if (Date.now() >= deadline) {
        const info = readJson(path);
        throw new CargoMutantsError(`another Cupel Rust run is using this build session (pid ${info?.pid ?? '?'}${info?.started ? `, started ${info.started}` : ''}); waited ${Math.round(waitMs / 1000)}s. Wait for it to finish, or set runners.cargo.mutants.session to false for a throwaway copy`);
      }
      await sleep(pollMs);
    }
  }
}

// ---- sync ----

const sameMode = (a, b) => (a.mode & 0o777) === (b.mode & 0o777);
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** Writes a file whole, flushed to disk, then renamed into place. */
function writeDurable(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not supported here */ }
}

/**
 * Makes `dest` the project the way copyProject does (same skips; node_modules folders linked; symbolic links
 * copied as links) while copying only what changed since the last sync and deleting what no longer exists.
 * `manifestFile` remembers each file's size, mtime and content hash at both ends; a file whose stat differs is
 * compared byte for byte and copied (new mtime, so Cargo rebuilds what it feeds) when it differs. A file a
 * crashed run left modified in `dest` therefore comes back. Every path listed in the dirty file (what Cupel
 * was about to write, recorded durably before it did, see openSession) skips the size and time shortcut: it
 * is always compared with the project byte for byte, and copied from it when it differs in any byte (a copy
 * that is already identical is left alone, so Cargo does not rebuild what it feeds); the list is cleared at the end. `root` is only read.
 * Returns the counts, `project` (the copy's real path) and `digest`: a SHA-256 over every path of the copy
 * with its content hash (links: target; files: mode), so equal digests mean the same project content.
 */
export function syncProject(root, dest, manifestFile, { dirtyFile = join(dirname(manifestFile), 'dirty.json') } = {}) {
  const old = readJson(manifestFile)?.files ?? {};
  const dirty = new Set(readJson(dirtyFile)?.paths ?? []);
  const files = {};
  const entries = [];
  const counts = { copied: 0, deleted: 0, unchanged: 0 };
  mkdirSync(dest, { recursive: true });
  const remove = (path) => { rmSync(path, { recursive: true, force: true }); counts.deleted++; };
  const walk = (from, to, rel) => {
    const list = readdirSync(from, { withFileTypes: true }).filter((e) => !SKIP.has(e.name));
    const names = new Set(list.map((e) => e.name));
    for (const name of readdirSync(to)) if (!names.has(name)) remove(join(to, name));
    for (const e of list) {
      const src = join(from, e.name); const dst = join(to, e.name); const path = rel ? `${rel}/${e.name}` : e.name;
      const d = lstatSync(dst, { throwIfNoEntry: false });
      const link = (target) => {
        if (d?.isSymbolicLink() && readlinkSync(dst) === target) counts.unchanged++;
        else {
          if (d) remove(dst);
          symlinkSync(target, dst, e.name === 'node_modules' ? 'junction' : undefined);
          counts.copied++;
        }
        entries.push(['l', path, target]);
      };
      if (e.name === 'node_modules' && e.isDirectory()) link(src);
      else if (e.isSymbolicLink()) link(readlinkSync(src));
      else if (e.isDirectory()) {
        if (d && !d.isDirectory()) remove(dst);
        else if (d?.isSymbolicLink()) remove(dst);
        if (!lstatSync(dst, { throwIfNoEntry: false })) mkdirSync(dst);
        entries.push(['d', path]);
        walk(src, dst, path);
      } else if (e.isFile()) {
        const s = lstatSync(src);
        const rec = old[path];
        let current = d?.isFile() ? d : null;
        let hash = null;
        const fresh = current && !dirty.has(path) && rec?.hash && rec.size === s.size && rec.sm === s.mtimeMs && rec.sc === s.ctimeMs && rec.si === s.ino && rec.dsize === current.size && rec.dm === current.mtimeMs && sameMode(s, current);
        if (fresh) hash = rec.hash; // the hash of what the copy held when it was last written or compared
        else if (current) {
          try {
            const a = current.size === s.size ? readFileSync(src) : null;
            if (a && a.equals(readFileSync(dst))) hash = sha(a); else current = null;
          } catch { current = null; }
        }
        if (current) {
          if (!sameMode(s, current)) chmodSync(dst, s.mode & 0o777);
          counts.unchanged++;
        } else {
          if (d) rmSync(dst, { recursive: true, force: true });
          copyFileSync(src, dst);
          counts.copied++;
          hash = hashFile(dst);
        }
        const dd = lstatSync(dst);
        files[path] = { size: s.size, sm: s.mtimeMs, sc: s.ctimeMs, si: s.ino, dsize: dd.size, dm: dd.mtimeMs, hash };
        entries.push(['f', path, hash, dd.mode & 0o777]);
      }
    }
  };
  walk(root, dest, '');
  writeAtomic(manifestFile, `${JSON.stringify({ files })}\n`);
  rmSync(dirtyFile, { force: true });
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
  return { ...counts, project: realpathSync(dest), digest: sha(JSON.stringify(entries)) };
}

// ---- sessions ----

const emptyMeta = (id) => ({ version: META_VERSION, sessionId: id, lastUsed: 0, baselines: {}, switched: {} });

/** Refuses a cache folder inside the assessed project (it would be copied into itself, and tests could read it). */
export function assertCacheOutside(cache, root) {
  const real = (path) => { // the real path of the nearest existing ancestor plus the rest
    const rest = [];
    for (let p = resolve(path); ; p = dirname(p)) {
      try { return join(realpathSync(p), ...rest.reverse()); } catch { rest.push(basename(p)); }
      if (dirname(p) === p) return resolve(path);
    }
  };
  const rel = relative(real(root), real(cache));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new CargoMutantsError(`the Cupel cache folder ${cache} is inside the assessed project ${root}; set CUPEL_CACHE_DIR to a folder outside it`);
  }
}

/**
 * Opens (creating it if needed) and locks the session `id` of a project, then syncs its project copy.
 * Returns { dir, project, target, warm, meta, sync, save(), markDirty(path), release() }. `warm` is true when the
 * session was used before (its meta is kept; meta of any other session id is never read). Call
 * `markDirty(file)` with every file of the copy Cupel is about to write: the path is stored durably in
 * `dirty.json` first, and the next sync copies it again from the project whatever its size and time.
 */
export async function openSession({ root, id, env = process.env, waitMs, pollMs, now = () => Date.now() }) {
  assertCacheOutside(cacheDir(env), root);
  const dir = join(sessionsRoot(env), id);
  mkdirSync(dir, { recursive: true });
  const release = await acquireLock(join(dir, 'lock'), { waitMs, pollMs });
  try {
    const stored = readJson(join(dir, 'meta.json'));
    const usable = stored?.version === META_VERSION && stored.sessionId === id && existsSync(join(dir, 'project'));
    const currentCache = realpathSync(cacheDir(env));
    const currentProject = realpathSync(root);
    if (usable && ((stored.cacheDir && stored.cacheDir !== currentCache) || (stored.project && stored.project !== currentProject))) {
      throw new CargoMutantsError(`this Cupel Rust build bundle was moved: it was prepared with cache ${stored.cacheDir ?? '(unknown)'} and project ${stored.project ?? '(unknown)'}, but is now at cache ${currentCache} and project ${currentProject}. Restore the bundle at the same absolute cache and project paths on every machine because compiled tests embed paths such as CARGO_MANIFEST_DIR`);
    }
    const warm = Boolean(usable && existsSync(join(dir, 'target')));
    const meta = usable ? { ...emptyMeta(id), ...stored } : emptyMeta(id);
    if (!usable) rmSync(join(dir, 'target'), { recursive: true, force: true }); // a target without its meta was built for who knows what
    meta.lastUsed = now();
    meta.cacheDir = currentCache;
    meta.project = currentProject;
    mkdirSync(join(dir, 'target'), { recursive: true });
    const synced = syncProject(root, join(dir, 'project'), join(dir, 'sync.json'), { dirtyFile: join(dir, 'dirty.json') });
    const dirty = new Set();
    const session = {
      dir, project: synced.project, target: join(dir, 'target'), warm, meta, sync: synced, release,
      save() { writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`); },
      markDirty(path) {
        const rel = (isAbsolute(path) ? relative(synced.project, path) : path).split(/[\\/]/).join('/');
        if (dirty.has(rel)) return;
        dirty.add(rel);
        writeDurable(join(dir, 'dirty.json'), `${JSON.stringify({ paths: [...dirty].sort() })}\n`);
      },
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

const TOMBSTONE = /\.deleting-/;

/** Removes what an interrupted eviction or clean left: session folders renamed to `<id>.deleting-<random>`. */
function sweepTombstones(env) {
  const base = sessionsRoot(env);
  try { for (const name of readdirSync(base)) if (TOMBSTONE.test(name)) rmSync(join(base, name), { recursive: true, force: true }); } catch { /* none */ }
}

/** Removes a session while holding its lock: the folder is renamed to a tombstone first (atomic), so a run that takes the lock afterwards finds no folder, then the tombstone is deleted. */
function removeLocked(dir, release) {
  const tomb = `${dir}.deleting-${randomUUID().slice(0, 8)}`;
  try { renameSync(dir, tomb); } finally { release(); }
  rmSync(tomb, { recursive: true, force: true });
}

function listSessions(env) {
  const base = sessionsRoot(env);
  if (!existsSync(base)) return [];
  sweepTombstones(env);
  return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !TOMBSTONE.test(e.name)).map((e) => {
    const dir = join(base, e.name);
    const meta = readJson(join(dir, 'meta.json'));
    return { id: e.name, dir, project: meta?.project ?? null, lastUsed: meta?.lastUsed ?? 0, bytes: folderSize(dir), locked: lockHeld(join(dir, 'lock')) };
  });
}

/**
 * Removes the least recently used sessions until all together fit under the cap. The session named by
 * `keep` and any locked session are never removed. Returns { removed: [ids], bytes: total after }. The cap covers the sessions of every project on the machine.
 */
export function enforceCap({ env = process.env, capBytes = DEFAULT_CAP_GB * GB, keep = null } = {}) {
  const all = listSessions(env);
  let total = all.reduce((a, s) => a + s.bytes, 0);
  const removed = [];
  for (const s of all.filter((x) => x.id !== keep && !x.locked).sort((a, b) => (a.lastUsed - b.lastUsed) || (a.id < b.id ? -1 : 1))) {
    if (total <= capBytes) break;
    const release = tryAcquireLock(join(s.dir, 'lock')); // a session cannot be removed while a run holds or takes it
    if (!release) continue;
    removeLocked(s.dir, release);
    total -= s.bytes;
    removed.push(s.id);
  }
  return { removed, bytes: total };
}

/** `cupel clean --rust-sessions`: removes every session that is not in use (with `project`, only that project's). */
export function cleanSessions({ env = process.env, project = null } = {}) {
  const real = project ? realpathSync(project) : null;
  const all = listSessions(env).filter((s) => !real || s.project === real);
  const removed = []; const busy = [];
  let bytes = 0;
  for (const s of all) {
    const release = s.locked ? null : tryAcquireLock(join(s.dir, 'lock'));
    if (!release) { busy.push(s.id); continue; }
    removeLocked(s.dir, release);
    removed.push(s.id); bytes += s.bytes;
  }
  try { if (!readdirSync(sessionsRoot(env)).length) rmSync(sessionsRoot(env), { recursive: true, force: true }); } catch { /* none */ }
  return { removed, busy, bytes };
}
