// Persistent Rust build sessions: id, sync, lock, cap and eviction (session.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, tryAcquireLock, cacheDir, cleanSessions, enforceCap, hashFile, openSession, sessionId, sessionsRoot, syncProject } from '../src/mutate-cargo/session.mjs';
import { copyProject } from '../src/mutate/index.mjs';

const cacheEnv = () => ({ ...process.env, CUPEL_CACHE_DIR: realpathSync(mkdtempSync(join(tmpdir(), 'cupel-cache-'))) });
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'cupel-session-')));
const put = (root, path, text, mode) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
  if (mode) chmodSync(join(root, path), mode);
};

/** Every entry of a tree with its kind, size, mtime and content or link target. */
function snapshot(root, rel = '') {
  const out = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, path));
    if (st.isSymbolicLink()) out[path] = ['link', readlinkSync(join(root, path))];
    else if (st.isDirectory()) { out[path] = ['dir']; Object.assign(out, snapshot(root, path)); }
    else out[path] = ['file', st.size, st.mtimeMs, readFileSync(join(root, path), 'utf8')];
  }
  return out;
}
const shape = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, v[0] === 'file' ? ['file', v[3]] : v]));

function project() {
  const root = tmp();
  put(root, 'Cargo.toml', '[workspace]\nmembers = ["a"]\n');
  put(root, 'a/src/lib.rs', 'pub fn f() -> i32 { 1 }\n');
  put(root, 'a/tests/it.rs', '#[test] fn t() {}\n');
  put(root, 'run.sh', '#!/bin/sh\n', 0o755);
  put(root, '.git/HEAD', 'ref\n');
  put(root, '.scratch/x/y', 'scratch\n');
  put(root, '.cupel/input.json', '{}');
  put(root, 'target/debug/out', 'build\n');
  put(root, 'a/target/inner', 'nested target skipped like copyProject\n');
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, 'web/node_modules/pkg'), { recursive: true });
  put(root, 'web/node_modules/pkg/index.js', 'x');
  put(root, 'web/app.js', 'y');
  symlinkSync('a/src/lib.rs', join(root, 'alias.rs'));
  return root;
}

test('session id covers the toolchain, flags, config and version, but not sources, and ignores mutants.*', () => {
  const root = project();
  try {
    const base = { root, rustc: 'rustc 1.97.1', cargo: 'cargo 1.97.1', host: 'aarch64-apple-darwin', rustflags: '--cap-lints=allow', runner: { tests: 'x', mutants: { jobs: 2 } }, version: '0.4.0' };
    const id = sessionId(base);
    assert.match(id, /^[0-9a-f]{32}$/);
    put(root, 'a/src/lib.rs', 'pub fn f() -> i32 { 2 }\n');
    assert.equal(sessionId(base), id, 'a source edit keeps the session');
    assert.equal(sessionId({ ...base, runner: { tests: 'x', mutants: { jobs: 9, backend: 'cupel' } } }), id, 'mutants.* is not part of it');
    for (const change of [{ rustc: 'rustc 1.98.0' }, { cargo: 'cargo 1.98' }, { host: 'x86_64-unknown-linux-gnu' }, { rustflags: '' }, { encodedRustflags: 'a' }, { runner: { tests: 'y' } }, { version: '0.5.0' }, { root: tmp() }]) {
      assert.notEqual(sessionId({ ...base, ...change }), id, JSON.stringify(change));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sync makes the copy what copyProject makes, copies only changes, deletes what is gone, and never touches the project', () => {
  const root = project(); const out = tmp();
  try {
    const dest = join(out, 'project'); const manifest = join(out, 'sync.json');
    const reference = copyProject(root, join(out, 'reference'));
    const before = snapshot(root);
    const first = syncProject(root, dest, manifest);
    assert.deepEqual(shape(snapshot(dest)), shape(snapshot(reference)));
    assert.ok(first.copied > 0);
    assert.equal(lstatSync(join(dest, 'web/node_modules')).isSymbolicLink(), true);
    assert.equal(lstatSync(join(dest, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(existsSync(join(dest, 'target')), false);
    assert.equal(existsSync(join(dest, 'a/target')), false);
    assert.equal(existsSync(join(dest, '.scratch')), false);

    const stamp = snapshot(dest)['a/tests/it.rs'][2];
    const again = syncProject(root, dest, manifest);
    assert.equal(again.copied, 0); assert.equal(again.deleted, 0);
    assert.equal(snapshot(dest)['a/tests/it.rs'][2], stamp, 'an unchanged file is not rewritten');

    // The project changes: an edit, an added file, a removed file and folder, a file turned into a folder.
    put(root, 'a/src/lib.rs', 'pub fn f() -> i32 { 3 }\n');
    put(root, 'a/src/new.rs', 'new\n');
    rmSync(join(root, 'a/tests'), { recursive: true });
    rmSync(join(root, 'empty'), { recursive: true });
    rmSync(join(root, 'alias.rs')); mkdirSync(join(root, 'alias.rs')); put(root, 'alias.rs/mod.rs', 'm\n');
    const ref2 = copyProject(root, join(out, 'reference2'));
    const second = syncProject(root, dest, manifest);
    assert.deepEqual(shape(snapshot(dest)), shape(snapshot(ref2)));
    assert.ok(second.deleted >= 3);
    assert.ok(second.copied >= 2);
    assert.equal(snapshot(dest)['a/src/new.rs'][3], 'new\n');

    // The project was only read: compare against what it held, apart from our own edits above.
    assert.equal(snapshot(root)['.git/HEAD'][3], 'ref\n');
    assert.deepEqual(Object.keys(before).filter((k) => !Object.hasOwn(snapshot(root), k)).sort(), ['a/tests', 'a/tests/it.rs', 'empty'].sort());
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('sync leaves byte-identical copy files untouched when restored project files have new stat keys', () => {
  const root = project(); const out = tmp();
  try {
    const dest = join(out, 'project'); const manifest = join(out, 'sync.json');
    syncProject(root, dest, manifest);
    const source = join(root, 'a/src/lib.rs');
    const copy = join(dest, 'a/src/lib.rs');
    const before = lstatSync(copy);
    writeFileSync(`${source}.restored`, readFileSync(source));
    renameSync(`${source}.restored`, source); // new inode and ctime, as after artifact/checkout restoration
    const synced = syncProject(root, dest, manifest);
    const after = lstatSync(copy);
    assert.equal(synced.copied, 0);
    assert.equal(after.ino, before.ino, 'the session copy was not replaced');
    assert.equal(after.mtimeMs, before.mtimeMs, 'Cargo freshness metadata was preserved');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('a file a crashed run left modified in the session is restored, even with the same size and an older mtime', () => {
  const root = project(); const out = tmp();
  try {
    const dest = join(out, 'project'); const manifest = join(out, 'sync.json');
    syncProject(root, dest, manifest);
    const file = join(dest, 'a/src/lib.rs');
    const original = readFileSync(file, 'utf8');
    const planted = original.replace('1', '0');
    assert.equal(planted.length, original.length);
    writeFileSync(file, planted);
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    put(dest, 'a/src/__cupel_stray.rs', 'switch module\n'); // a leftover file
    const r = syncProject(root, dest, manifest);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(join(dest, 'a/src/__cupel_stray.rs')), false);
    assert.ok(r.copied >= 1 && r.deleted >= 1);
    assert.ok(lstatSync(file).mtimeMs > 1_000_000 * 2, 'the restored file is newer, so Cargo rebuilds what it feeds');
    // Also without any manifest at all.
    writeFileSync(file, planted);
    rmSync(manifest);
    syncProject(root, dest, manifest);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('lock: a second run waits then refuses clearly; a lock of a dead process is taken over', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'lock');
    const release = await acquireLock(path);
    const info = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(info.pid, process.pid);
    assert.ok(info.started);
    const t0 = Date.now();
    await assert.rejects(acquireLock(path, { waitMs: 300, pollMs: 50 }), /another Cupel Rust run is using this build session \(pid \d+/);
    assert.ok(Date.now() - t0 >= 250, 'it waited');
    release();
    assert.equal(existsSync(path), false);
    const again = await acquireLock(path, { waitMs: 300 });
    again();

    const dead = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(path, JSON.stringify({ pid: dead.pid, started: 'long ago' }));
    const taken = await acquireLock(path, { waitMs: 300 });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    taken();

    // One that frees itself while the second waits.
    const first = await acquireLock(path);
    setTimeout(first, 150);
    const second = await acquireLock(path, { waitMs: 3000, pollMs: 25 });
    second();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('openSession: cold then warm, meta of another session id is never reused, and the project is only read', async () => {
  const root = project(); const env = cacheEnv();
  try {
    const before = snapshot(root);
    const a = await openSession({ root, id: 'aaaa', env });
    assert.equal(a.warm, false);
    a.meta.baselines.k = { hashes: ['h'], names: ['t'], ms: 5, failing: [] };
    a.save(); a.release();
    const warm = await openSession({ root, id: 'aaaa', env });
    assert.equal(warm.warm, true);
    assert.deepEqual(warm.meta.baselines.k.hashes, ['h']);
    assert.equal(existsSync(join(warm.dir, 'target')), true);
    warm.release();
    // Meta copied under another id (as if the folder were moved) is not trusted.
    rmSync(join(sessionsRoot(env), 'bbbb'), { recursive: true, force: true });
    mkdirSync(join(sessionsRoot(env), 'bbbb'));
    writeFileSync(join(sessionsRoot(env), 'bbbb', 'meta.json'), readFileSync(join(warm.dir, 'meta.json')));
    const b = await openSession({ root, id: 'bbbb', env });
    assert.equal(b.warm, false);
    assert.deepEqual(b.meta.baselines, {});
    b.release();
    const after = snapshot(root);
    for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(Object.keys(after), Object.keys(before), 'nothing is added to the project');
    assert.equal(warm.dir.startsWith(env.CUPEL_CACHE_DIR), true);
    assert.equal(JSON.parse(readFileSync(join(warm.dir, 'meta.json'), 'utf8')).project, root);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(env.CUPEL_CACHE_DIR, { recursive: true, force: true }); }
});

test('a restored session is refused when its absolute cache or project path moved', async () => {
  const root = project(); const env = cacheEnv(); const movedCache = `${env.CUPEL_CACHE_DIR}-moved`; const movedProject = `${root}-moved`;
  try {
    const session = await openSession({ root, id: 'portable', env });
    const meta = JSON.parse(readFileSync(join(session.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.cacheDir, env.CUPEL_CACHE_DIR);
    assert.equal(meta.project, root);
    session.release();
    renameSync(env.CUPEL_CACHE_DIR, movedCache);
    await assert.rejects(openSession({ root, id: 'portable', env: { ...env, CUPEL_CACHE_DIR: movedCache } }), /bundle was moved.*same absolute cache and project paths/);
    renameSync(movedCache, env.CUPEL_CACHE_DIR);
    renameSync(root, movedProject);
    await assert.rejects(openSession({ root: movedProject, id: 'portable', env }), /bundle was moved.*same absolute cache and project paths/);
    renameSync(movedProject, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(movedProject, { recursive: true, force: true });
    rmSync(env.CUPEL_CACHE_DIR, { recursive: true, force: true });
    rmSync(movedCache, { recursive: true, force: true });
  }
});

function fakeSession(env, id, lastUsed, bytes, project = null) {
  const dir = join(sessionsRoot(env), id);
  mkdirSync(join(dir, 'target'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ version: 1, sessionId: id, lastUsed, project }));
  writeFileSync(join(dir, 'target', 'blob'), Buffer.alloc(bytes));
  return dir;
}

test('eviction removes least recently used sessions first, never the current or a locked one, and stops under the cap', async () => {
  const env = cacheEnv();
  try {
    for (const [id, used] of [['s1', 100], ['s2', 300], ['s3', 200], ['s4', 400], ['s5', 50]]) fakeSession(env, id, used, 1000);
    // s5 (oldest) is in use, s4 is the current one.
    const holder = await acquireLock(join(sessionsRoot(env), 's5', 'lock'));
    const r = enforceCap({ env, capBytes: 3600, keep: 's4' });
    assert.deepEqual(r.removed, ['s1', 's3']);
    assert.ok(r.bytes <= 3600 && r.bytes >= 2999);
    assert.equal(existsSync(join(sessionsRoot(env), 's5')), true);
    assert.equal(existsSync(join(sessionsRoot(env), 's4')), true);
    assert.deepEqual(enforceCap({ env, capBytes: 10 ** 9, keep: 's4' }).removed, [], 'under the cap nothing more goes');
    assert.deepEqual(enforceCap({ env, capBytes: 0, keep: 's4' }).removed, ['s2'], 'the current and locked ones stay');
    holder();
    assert.deepEqual(cleanSessions({ env }).removed.sort(), ['s4', 's5']);
    assert.equal(existsSync(sessionsRoot(env)), false);
    assert.deepEqual(cleanSessions({ env }).removed, [], 'nothing to clean is fine');
  } finally { rmSync(env.CUPEL_CACHE_DIR, { recursive: true, force: true }); }
});

test('clean leaves a session in use alone, and --project limits it to one project', async () => {
  const env = cacheEnv(); const a = tmp(); const b = tmp();
  try {
    fakeSession(env, 'old', 1, 10, a); fakeSession(env, 'busy', 2, 10, a); fakeSession(env, 'other', 3, 10, b);
    const release = await acquireLock(join(sessionsRoot(env), 'busy', 'lock'));
    const r = cleanSessions({ env, project: a });
    assert.deepEqual(r.removed, ['old']); assert.deepEqual(r.busy, ['busy']);
    assert.equal(existsSync(join(sessionsRoot(env), 'other')), true);
    release();
  } finally { for (const d of [env.CUPEL_CACHE_DIR, a, b]) rmSync(d, { recursive: true, force: true }); }
});

test('the cache folder follows CUPEL_CACHE_DIR, then XDG_CACHE_HOME', () => {
  assert.equal(cacheDir({ CUPEL_CACHE_DIR: '/x', XDG_CACHE_HOME: '/y' }), '/x');
  assert.equal(cacheDir({ XDG_CACHE_HOME: '/y' }), join('/y', 'cupel'));
  assert.match(cacheDir({}), /cupel$/);
});

test('hashFile is the SHA-256 of the content', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'x'), 'abc');
    assert.equal(hashFile(join(dir, 'x')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cupel clean --rust-sessions removes every session, --project only the current project\'s', async () => {
  const root = tmp(); const other = tmp(); const env = cacheEnv();
  try {
    mkdirSync(join(root, '.git'));
    fakeSession(env, 'x1', 1, 2048, root); fakeSession(env, 'x2', 2, 2048, other);
    const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
    const cli = (...args) => spawnSync(process.execPath, [bin, 'clean', ...args, '--root', root], { cwd: root, env, encoding: 'utf8' });
    const mine = cli('--rust-sessions', '--project');
    assert.equal(mine.status, 0, mine.stderr);
    assert.match(mine.stdout, /removed 1 Rust build session/);
    assert.equal(existsSync(join(sessionsRoot(env), 'x2')), true);
    const all = cli('--rust-sessions');
    assert.match(all.stdout, /removed 1 Rust build session/);
    assert.equal(existsSync(sessionsRoot(env)), false);
    assert.equal(cli().status, 2);
  } finally { for (const d of [root, other, env.CUPEL_CACHE_DIR]) rmSync(d, { recursive: true, force: true }); }
});

test('the sync digest covers every file: a changed data file of the same size and time changes it, a plain re-sync does not', () => {
  const root = project(); const out = tmp();
  try {
    put(root, 'a/data.txt', 'aaaa\n');
    const dest = join(out, 'project'); const manifest = join(out, 'sync.json');
    const first = syncProject(root, dest, manifest);
    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.equal(syncProject(root, dest, manifest).digest, first.digest, 'unchanged project, same digest');
    assert.equal(syncProject(root, join(out, 'other'), join(out, 'other.json')).digest, first.digest, 'a cold copy gives the same digest');
    utimesSync(join(root, 'a/data.txt'), 1_700_000_000, 1_700_000_000);
    const first2 = syncProject(root, dest, manifest).digest;
    assert.equal(first2, first.digest, 'times are not part of the digest');
    put(root, 'a/data.txt', 'bbbb\n');
    utimesSync(join(root, 'a/data.txt'), 1_700_000_000, 1_700_000_000); // same size, same mtime in the project
    const changed = syncProject(root, join(out, 'third'), join(out, 'third.json')).digest;
    assert.notEqual(changed, first.digest, 'content is part of it');
    put(root, 'a/mode.txt', 'x\n', 0o644);
    const d1 = syncProject(root, dest, manifest).digest;
    chmodSync(join(root, 'a/mode.txt'), 0o755);
    assert.notEqual(syncProject(root, dest, manifest).digest, d1, 'a mode change is part of it');
    rmSync(join(root, 'a/mode.txt'));
    put(root, 'a/data.txt', 'aaaa\n');
    assert.equal(syncProject(root, dest, manifest).digest, first.digest, 'back to the first project');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('a dirty entry restores a file byte for byte even when size and mtime were put back; the list is cleared after the sync', () => {
  const root = project(); const out = tmp();
  try {
    const dest = join(out, 'project'); const manifest = join(out, 'sync.json'); const dirtyFile = join(out, 'dirty.json');
    syncProject(root, dest, manifest);
    const file = join(dest, 'a/src/lib.rs');
    const original = readFileSync(file, 'utf8');
    utimesSync(file, 1_700_000_000, 1_700_000_000); // whole seconds, so putting the time back is exact
    syncProject(root, dest, manifest);
    const stat = lstatSync(file);
    const plant = () => { writeFileSync(file, original.replace('1', '0')); utimesSync(file, stat.atime, stat.mtime); };
    plant();
    assert.equal(lstatSync(file).size, stat.size);
    assert.equal(lstatSync(file).mtimeMs, stat.mtimeMs);
    syncProject(root, dest, manifest);
    assert.notEqual(readFileSync(file, 'utf8'), original, 'the stat check alone trusts equal size and time (the hole the dirty list closes)');
    writeFileSync(dirtyFile, JSON.stringify({ paths: ['a/src/lib.rs'] }));
    const r = syncProject(root, dest, manifest);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.ok(r.copied >= 1);
    assert.equal(existsSync(dirtyFile), false, 'cleared');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('openSession.markDirty stores the path durably before the write, and the next open restores it', async () => {
  const root = project(); const env = cacheEnv();
  try {
    const a = await openSession({ root, id: 'dd', env });
    const file = join(a.project, 'a/src/lib.rs');
    const original = readFileSync(file, 'utf8');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const stat = lstatSync(file);
    a.markDirty(file);
    assert.deepEqual(JSON.parse(readFileSync(join(a.dir, 'dirty.json'), 'utf8')).paths, ['a/src/lib.rs'], 'on disk before any write');
    a.markDirty(file); a.markDirty('a/tests/it.rs');
    assert.deepEqual(JSON.parse(readFileSync(join(a.dir, 'dirty.json'), 'utf8')).paths, ['a/src/lib.rs', 'a/tests/it.rs']);
    writeFileSync(file, original.replace('1', '9')); utimesSync(file, stat.atime, stat.mtime); // a crash here
    a.release();
    const b = await openSession({ root, id: 'dd', env });
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(join(b.dir, 'dirty.json')), false);
    b.release();
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(env.CUPEL_CACHE_DIR, { recursive: true, force: true }); }
});

test('lock: of many contenders for a stale lock exactly one wins, and a release never removes another run\'s lock', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'lock');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(path, JSON.stringify({ pid: dead.pid, started: 'long ago', token: 'old' }));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(path, { waitMs: 150, pollMs: 10 })));
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 7);
    const info = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(info.pid, process.pid); assert.ok(info.token);
    assert.deepEqual(readdirSync(dir), ['lock'], 'no stale leftovers');
    // Someone else's lock in the file: our release leaves it.
    writeFileSync(path, JSON.stringify({ pid: process.pid, started: 'x', token: 'someone-else' }));
    won[0].value();
    assert.equal(existsSync(path), true);
    rmSync(path);
    // Non-blocking: a free lock is taken, a held one is not.
    const release = tryAcquireLock(path);
    assert.equal(typeof release, 'function');
    assert.equal(tryAcquireLock(path), null);
    release();
    assert.equal(tryAcquireLock(join(dir, 'missing', 'lock')), null, 'no folder, nothing to lock');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eviction and clean take the session lock first: a session a run holds or takes is skipped, a dead holder\'s is removed', async () => {
  const env = cacheEnv();
  try {
    for (const [id, used] of [['old1', 1], ['old2', 2], ['new', 9]]) fakeSession(env, id, used, 1000);
    const dead = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(join(sessionsRoot(env), 'old1', 'lock'), JSON.stringify({ pid: dead.pid, started: 'x' }));
    // old2 gets locked by a run after the listing: simulate by holding it with a live lock the listing sees as held.
    const holder = await acquireLock(join(sessionsRoot(env), 'old2', 'lock'));
    const r = enforceCap({ env, capBytes: 0, keep: 'new' });
    assert.deepEqual(r.removed, ['old1']);
    assert.equal(existsSync(join(sessionsRoot(env), 'old2')), true);
    const c = cleanSessions({ env });
    assert.deepEqual(c.busy, ['old2']);
    holder();
    assert.deepEqual(cleanSessions({ env }).removed.sort(), ['old2']);
  } finally { rmSync(env.CUPEL_CACHE_DIR, { recursive: true, force: true }); }
});

test('a cache folder inside the assessed project is refused, however it is derived', async () => {
  const root = project(); const out = tmp();
  try {
    for (const env of [{ CUPEL_CACHE_DIR: join(root, '.scratch/cache') }, { CUPEL_CACHE_DIR: root }, { XDG_CACHE_HOME: join(root, 'x') }, { CUPEL_CACHE_DIR: join(root, 'a', '..', 'b') }]) {
      await assert.rejects(openSession({ root, id: 'in', env }), /cache folder .* is inside the assessed project/, JSON.stringify(env));
    }
    assert.equal(existsSync(join(root, '.scratch/cache')), false, 'nothing was created');
    const link = join(out, 'link'); symlinkSync(root, link);
    await assert.rejects(openSession({ root, id: 'in', env: { CUPEL_CACHE_DIR: join(link, 'c') } }), /inside the assessed project/, 'through a symbolic link');
    const ok = await openSession({ root, id: 'out', env: { CUPEL_CACHE_DIR: join(out, 'cache') } });
    ok.release();
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('a same-width edit with the mtime put back is still seen: the project side stat key holds ctime and inode', () => {
  const root = project(); const out = tmp();
  try {
    const dest = join(out, 'project'); const manifest = join(out, 'sync.json');
    const file = join(root, 'a/src/lib.rs');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const first = syncProject(root, dest, manifest);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('1', '7'));
    utimesSync(file, 1_700_000_000, 1_700_000_000); // cp -p, rsync -t
    const again = syncProject(root, dest, manifest);
    assert.notEqual(again.digest, first.digest);
    assert.ok(again.copied >= 1);
    assert.equal(readFileSync(join(dest, 'a/src/lib.rs'), 'utf8'), original.replace('1', '7'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('lock: a live run that appears between judging a lock stale and breaking it keeps its lock; the breaker file is removed', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'lock');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    writeFileSync(path, JSON.stringify({ pid: dead.pid, started: 'long ago', token: 'old' }));
    const live = JSON.stringify({ pid: process.pid, started: 'now', token: 'live' });
    await assert.rejects(acquireLock(path, { waitMs: 100, pollMs: 10, hooks: { afterJudge: () => { rmSync(path); writeFileSync(path, live); } } }), /another Cupel Rust run/);
    assert.equal(readFileSync(path, 'utf8'), live);
    assert.equal(existsSync(`${path}.break`), false);
    // A breaker of a live run in progress makes others wait; one of a dead process older than 30 s is removed.
    rmSync(path);
    writeFileSync(path, JSON.stringify({ pid: dead.pid, started: 'x', token: 'old' }));
    writeFileSync(`${path}.break`, JSON.stringify({ pid: process.pid }));
    await assert.rejects(acquireLock(path, { waitMs: 100, pollMs: 10 }), /another Cupel Rust run/);
    writeFileSync(`${path}.break`, JSON.stringify({ pid: dead.pid }));
    utimesSync(`${path}.break`, 1_000_000, 1_000_000);
    (await acquireLock(path, { waitMs: 500, pollMs: 10 }))();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eviction and clean rename the session to a tombstone under the lock, and leftover tombstones are swept', () => {
  const env = cacheEnv();
  try {
    fakeSession(env, 'gone', 1, 100); fakeSession(env, 'keep', 2, 100);
    mkdirSync(join(sessionsRoot(env), 'x.deleting-abc123'), { recursive: true });
    writeFileSync(join(sessionsRoot(env), 'x.deleting-abc123', 'blob'), 'left over');
    const r = enforceCap({ env, capBytes: 150, keep: 'keep' });
    assert.deepEqual(r.removed, ['gone']);
    assert.deepEqual(readdirSync(sessionsRoot(env)), ['keep']);
    mkdirSync(join(sessionsRoot(env), 'y.deleting-1'));
    assert.deepEqual(cleanSessions({ env }).removed, ['keep']);
    assert.equal(existsSync(sessionsRoot(env)), false);
  } finally { rmSync(env.CUPEL_CACHE_DIR, { recursive: true, force: true }); }
});
