// Git helpers for the CLI. Read-only towards the user's working tree: nothing here checks out,
// stashes, resets or writes inside the repository. The base of a comparison is unpacked from
// `git archive` into a fresh temporary directory.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { CliError, EXIT_ENV, EXIT_USAGE } from './errors.mjs';
import { cmp } from '../engine/order.mjs';

function git(args, cwd, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: opts.encoding ?? 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw new CliError(EXIT_ENV, `git could not run: ${r.error.message}`);
  return r;
}

/** The repository root containing `cwd`, or null outside a git repository. */
export function gitRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const root = r.stdout.trim() || null;
  // Scratch projects are independent even when TMPDIR sits inside this repository.
  if (root && relative(root, cwd).split(sep)[0] === '.scratch') return null;
  return root;
}

/** Refuses refs that git would read as options. */
export function checkRef(ref, option) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) {
    throw new CliError(EXIT_USAGE, `${option} needs a git ref, got ${JSON.stringify(ref ?? '')}`);
  }
}

function resolveCommit(root, ref) {
  const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root);
  if (r.status !== 0) throw new CliError(EXIT_ENV, `git: ${JSON.stringify(ref)} is not a commit`);
  return r.stdout.trim();
}

/**
 * Unpacks the tree of `ref` into a new directory under os.tmpdir() (`git archive <ref> | tar -x`).
 * Returns { dir, cleanup }. The caller must call cleanup().
 */
export function extractRef(root, ref) {
  if (!root) throw new CliError(EXIT_ENV, 'git: not inside a git repository');
  const commit = resolveCommit(root, ref);
  // The real path, so coverage URLs the runtime reports (symlinks resolved) match the root.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-base-')));
  const cleanup = () => rmSync(parent, { recursive: true, force: true });
  try {
    const tar = join(parent, 'base.tar');
    const dir = join(parent, 'tree');
    mkdirSync(dir);
    const a = git(['archive', '--format=tar', `--output=${tar}`, commit], root);
    if (a.status !== 0) throw new CliError(EXIT_ENV, `git archive failed: ${a.stderr.trim().split('\n')[0]}`);
    const x = spawnSync('tar', ['-x', '-f', tar, '-C', dir], { encoding: 'utf8' });
    if (x.error || x.status !== 0) throw new CliError(EXIT_ENV, `tar failed: ${(x.error?.message ?? x.stderr).trim().split('\n')[0]}`);
    rmSync(tar, { force: true });
    return { dir, commit, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Unquotes a path as git prints it (C-style quoting when it holds special characters). */
export function unquotePath(p) {
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function addLines(map, path, start, count) {
  const list = map.get(path) ?? [];
  if (list !== null) list.push(count === 1 ? `${start}` : `${start}-${start + count - 1}`);
  map.set(path, list);
}

/**
 * Parses `git diff --unified=0` output into changed lines per path (argument `changed`).
 * - Added or modified lines count by their line numbers in the new file.
 * - A hunk that only deletes lines marks the line it follows (line 1 at the top of a file).
 * - A new file, or a file whose change has no line hunks (binary), counts as changed in full ("").
 * - Deleted files are left out: there is nothing left to test in them.
 */
export function parseUnifiedDiff(text) {
  const map = new Map(); // path -> array of ranges, or null for "changed in full"
  let path = null;
  let isNew = false;
  let deleted = false;
  let hunks = 0;
  let binary = false;
  const flush = () => {
    if (path === null || deleted) return;
    if (isNew || (binary && hunks === 0)) map.set(path, null);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      path = null;
      isNew = false;
      deleted = false;
      hunks = 0;
      binary = false;
      // With --no-renames both sides name the same path: `diff --git a/P b/P` (each side quoted alike).
      const rest = line.slice('diff --git '.length);
      path = unquotePath(rest.slice((rest.length + 1) / 2)).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('new file mode')) isNew = true;
    else if (line.startsWith('deleted file mode')) deleted = true;
    else if (line.startsWith('Binary files ')) binary = true;
    else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p === '/dev/null') deleted = true;
      else path = unquotePath(p).replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || path === null) continue;
      hunks++;
      if (isNew || deleted) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0) addLines(map, path, Math.max(start, 1), 1);
      else addLines(map, path, start, count);
    }
  }
  flush();
  const out = {};
  for (const [p, list] of [...map.entries()].sort(([a], [b]) => cmp(a, b))) {
    out[p] = list === null ? '' : list.join(',');
  }
  return out;
}

/**
 * Changed lines between `ref` and the working tree, per path relative to the repository root.
 * Untracked files that git does not ignore count as new, changed in full.
 */
export function changedLines(root, ref) {
  if (!root || gitRoot(root) !== resolve(root)) throw new CliError(EXIT_ENV, 'git: not inside a git repository');
  const commit = resolveCommit(root, ref);
  const d = git(['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', commit, '--'], root);
  if (d.status !== 0) throw new CliError(EXIT_ENV, `git diff failed: ${d.stderr.trim().split('\n')[0]}`);
  const changed = parseUnifiedDiff(d.stdout);
  const u = git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'], root);
  if (u.status !== 0) throw new CliError(EXIT_ENV, `git ls-files failed: ${u.stderr.trim().split('\n')[0]}`);
  for (const p of u.stdout.split('\0').filter(Boolean)) changed[p] = '';
  return Object.fromEntries(Object.entries(changed).sort(([a], [b]) => cmp(a, b)));
}
