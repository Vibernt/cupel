// Persistent Rust build sessions: id, sync, lock, cap and eviction (session.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, cleanSessions, enforceCap, hashFile, openSession, sessionId, sessionsRoot, syncProject } from '../src/mutate-cargo/session.mjs';
import { copyProject } from '../src/mutate/index.mjs';

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
  const root = project();
  try {
    const before = snapshot(root);
    const a = await openSession({ root, id: 'aaaa' });
    assert.equal(a.warm, false);
    a.meta.baselines.k = { hashes: ['h'], names: ['t'], ms: 5, failing: [] };
    a.save(); a.release();
    const warm = await openSession({ root, id: 'aaaa' });
    assert.equal(warm.warm, true);
    assert.deepEqual(warm.meta.baselines.k.hashes, ['h']);
    assert.equal(existsSync(join(warm.dir, 'target')), true);
    warm.release();
    // Meta copied under another id (as if the folder were moved) is not trusted.
    rmSync(join(sessionsRoot(root), 'bbbb'), { recursive: true, force: true });
    mkdirSync(join(sessionsRoot(root), 'bbbb'));
    writeFileSync(join(sessionsRoot(root), 'bbbb', 'meta.json'), readFileSync(join(warm.dir, 'meta.json')));
    const b = await openSession({ root, id: 'bbbb' });
    assert.equal(b.warm, false);
    assert.deepEqual(b.meta.baselines, {});
    b.release();
    const after = snapshot(root);
    for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(Object.keys(after).filter((k) => !Object.hasOwn(before, k) && !k.startsWith('.scratch/cupel-rust-sessions')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeSession(root, id, lastUsed, bytes) {
  const dir = join(sessionsRoot(root), id);
  mkdirSync(join(dir, 'target'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ version: 1, sessionId: id, lastUsed }));
  writeFileSync(join(dir, 'target', 'blob'), Buffer.alloc(bytes));
  return dir;
}

test('eviction removes least recently used sessions first, never the current or a locked one, and stops under the cap', async () => {
  const root = tmp();
  try {
    for (const [id, used] of [['s1', 100], ['s2', 300], ['s3', 200], ['s4', 400], ['s5', 50]]) fakeSession(root, id, used, 1000);
    const total = (names) => names.length * 1000;
    const size = (r) => r.bytes;
    // s5 (oldest) is in use, s4 is the current one.
    const holder = await acquireLock(join(sessionsRoot(root), 's5', 'lock'));
    const r = enforceCap(root, { capBytes: 3200, keep: 's4' });
    assert.deepEqual(r.removed, ['s1', 's3']);
    assert.ok(size(r) <= 3500 && size(r) > total(['s2', 's4', 's5']) - 1);
    assert.equal(existsSync(join(sessionsRoot(root), 's5')), true);
    assert.equal(existsSync(join(sessionsRoot(root), 's4')), true);
    // Under the cap nothing more goes.
    assert.deepEqual(enforceCap(root, { capBytes: 10 ** 9, keep: 's4' }).removed, []);
    // A cap nothing can meet still leaves the current and locked ones.
    assert.deepEqual(enforceCap(root, { capBytes: 0, keep: 's4' }).removed, ['s2']);
    holder();
    const cleaned = cleanSessions(root);
    assert.deepEqual(cleaned.removed.sort(), ['s4', 's5']);
    assert.equal(existsSync(sessionsRoot(root)), false);
    assert.deepEqual(cleanSessions(root).removed, [], 'nothing to clean is fine');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clean leaves a session in use alone', async () => {
  const root = tmp();
  try {
    fakeSession(root, 'old', 1, 10); fakeSession(root, 'busy', 2, 10);
    const release = await acquireLock(join(sessionsRoot(root), 'busy', 'lock'));
    const r = cleanSessions(root);
    assert.deepEqual(r.removed, ['old']); assert.deepEqual(r.busy, ['busy']);
    release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hashFile is the SHA-256 of the content', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'x'), 'abc');
    assert.equal(hashFile(join(dir, 'x')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cupel clean --rust-sessions removes every session', async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.git'));
    fakeSession(root, 'x1', 1, 2048);
    const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
    const r = spawnSync(process.execPath, [bin, 'clean', '--rust-sessions', '--root', root], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed 1 Rust build session/);
    assert.equal(existsSync(sessionsRoot(root)), false);
    assert.equal(spawnSync(process.execPath, [bin, 'clean', '--root', root], { cwd: root, encoding: 'utf8' }).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
