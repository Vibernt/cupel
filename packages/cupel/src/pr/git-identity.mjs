import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readOnlyInputSnapshot } from './profiles/node/inputs.mjs';
import policies from './profiles/node/input-policy.cjs';

const { EXPRESS, normalizeInputPolicy } = policies;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safePath = path => path && !path.startsWith('/') && !path.includes('\\') &&
  path.split('/').every(part => part && part !== '.' && part !== '..');

function git(root, ...args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-C', root, ...args], { encoding: 'buffer', timeout: 30000, maxBuffer: 16 << 20,
    env: { PATH: process.env.PATH ?? '', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0)
    throw new Error(`Node PR Git metadata query failed: ${result.error?.message ??
      result.stderr?.toString('utf8').split('\n')[0] ?? result.status}`);
  return result.stdout;
}

function records(buffer, index) {
  const result = new Map();
  for (const raw of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const tab = raw.indexOf('\t');
    if (tab < 0) throw new Error('Node PR Git record lacks a path');
    const path = raw.slice(tab + 1), metadata = raw.slice(0, tab).split(' ');
    if (!safePath(path) || result.has(path)) throw new Error('Node PR Git path is unsafe or duplicated');
    if (index ? metadata.length !== 3 || metadata[2] !== '0' :
        metadata.length !== 3 || metadata[1] !== 'blob')
      throw new Error('Node PR Git index or tree has an unsupported entry');
    const mode = metadata[0], oid = metadata[index ? 1 : 2];
    if (!['100644', '100755'].includes(mode) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
      throw new Error(`Node PR Git mode or object identity unsupported: ${path}`);
    result.set(path, { mode, oid });
  }
  return result;
}

/** Check exact HEAD, index, worktree bytes and privacy without Git diff/status. */
export function assertExactGitBaseline({ root, commit, inputPolicy = 'strict-v1' }) {
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    throw new Error('Node PR baseline requires an exact commit object ID');
  root = resolve(root);
  inputPolicy = normalizeInputPolicy(inputPolicy);
  if (realpathSync(root) !== root) throw new Error('Node PR baseline root is symlinked');
  const current = readOnlyInputSnapshot(root, { nodeModules: 'skip', inputPolicy });
  const top = git(root, 'rev-parse', '--show-toplevel').toString('utf8').trim();
  if (realpathSync(top) !== root) throw new Error('Node PR baseline is not the Git root');
  const head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}').toString('utf8').trim();
  if (head !== commit) throw new Error('Node PR baseline HEAD differs from exact commit');
  const tree = records(git(root, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'), false);
  const index = records(git(root, 'ls-files', '--stage', '-z'), true);
  if (!same([...tree], [...index])) throw new Error('Node PR Git index differs from exact HEAD tree');
  const opaque = inputPolicy === EXPRESS && current.opaqueRootNpmrc === 'regular';
  const expectedPaths = [...Object.keys(current.files), ...(opaque ? ['.npmrc'] : [])].sort();
  if (!same([...tree.keys()].sort(), expectedPaths))
    throw new Error('Node PR worktree inventory differs from exact HEAD tree');
  for (const [path, entry] of tree) {
    const disk = join(root, path), stat = lstatSync(disk);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error(`Node PR tracked path is not a unique regular file: ${path}`);
    const expectedMode = stat.mode & 0o111 ? '100755' : '100644';
    if (entry.mode !== expectedMode) throw new Error(`Node PR tracked mode changed: ${path}`);
    if (opaque && path === '.npmrc') continue;
    const bytes = readFileSync(disk);
    const algorithm = entry.oid.length === 40 ? 'sha1' : 'sha256';
    const actual = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== entry.oid) throw new Error(`Node PR tracked bytes differ from exact HEAD: ${path}`);
  }
  return { commit: head, fileCount: tree.size,
    tree: git(root, 'rev-parse', '--verify', 'HEAD^{tree}').toString('utf8').trim(),
    inputManifest: current.files, opaqueRootNpmrc: current.opaqueRootNpmrc,
    opaqueGit: opaque ? { path: '.npmrc', mode: tree.get('.npmrc').mode,
      oid: tree.get('.npmrc').oid } : null };
}

/** Require a committed, clean HEAD descended from the sealed base commit. */
export function assertExactGitHead({ root, baseCommit, inputPolicy = 'strict-v1' }) {
  if (typeof baseCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit))
    throw new Error('Node PR HEAD requires exact base commit identity');
  const commit = git(resolve(root), 'rev-parse', '--verify', 'HEAD^{commit}').toString('utf8').trim();
  git(resolve(root), 'merge-base', '--is-ancestor', baseCommit, commit);
  return assertExactGitBaseline({ root, commit, inputPolicy });
}
