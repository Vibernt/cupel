import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { format, normalize } from '../engine/lines.mjs';
import privacy from './profiles/node/privacy.cjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const PIN = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const safe = path => typeof path === 'string' && path && !path.startsWith('/') &&
  !path.includes('\\') && !privacy.privatePath(path) &&
  path.split('/').every(part => part && part !== '.' && part !== '..');
const lines = bytes => {
  const value = bytes.toString('utf8').split('\n');
  if (value.at(-1) === '') value.pop();
  return value;
};

/** A bounded LCS on exact source lines; retain both sides of changed hunks. */
export function changedLineSides(base, head, maxCells = 4_000_000) {
  const n = base.length, m = head.length;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 ||
      (n + 1) * (m + 1) > maxCells)
    throw new Error('Node PR changed-line comparison exceeds bounded matrix');
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const index = i * width + j;
    table[index] = base[i] === head[j] ? table[(i + 1) * width + j + 1] + 1 :
      Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const changedBase = [], changedHead = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === head[j]) { i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      changedBase.push(i + 1); i++;
    } else { changedHead.push(j + 1); j++; }
  }
  const formatChanged = values => format(normalize(values.map(line => [line, line])));
  return { base: formatChanged(changedBase), head: formatChanged(changedHead) };
}

export const changedHeadLines = (base, head, maxCells) =>
  changedLineSides(base, head, maxCells).head;

/** Read one declared nonprivate source blob, never a repository-wide diff. */
export function changedCriticalSourceLineSides({ root, baseCommit, source, baseHash, headHash }) {
  if (!COMMIT.test(baseCommit ?? '') || !safe(source) ||
      !PIN.test(baseHash ?? '') || !PIN.test(headHash ?? ''))
    throw new Error('Node PR changed source identity or path invalid');
  root = resolve(root);
  if (realpathSync(root) !== root) throw new Error('Node PR changed source root is symlinked');
  const path = resolve(root, source);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Node PR changed source escapes root');
  let current = root;
  for (const part of source.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Node PR changed source is symlinked');
  }
  if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1)
    throw new Error('Node PR changed source is not a unique regular file');
  const head = readFileSync(path);
  if (sha(head) !== headHash) throw new Error('Node PR HEAD source bytes differ from fresh inventory');
  const git = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-C', root, 'show', `${baseCommit}:${source}`], { encoding: 'buffer', timeout: 30000,
    maxBuffer: 16 << 20, env: { PATH: process.env.PATH ?? '', LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  if (git.error || git.status !== 0)
    throw new Error(`Node PR exact base source unavailable: ${source}`);
  if (sha(git.stdout) !== baseHash)
    throw new Error(`Node PR base source bytes differ from sealed baseline: ${source}`);
  return changedLineSides(lines(git.stdout), lines(head));
}

export const changedCriticalSourceLines = options =>
  changedCriticalSourceLineSides(options).head;
