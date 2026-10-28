import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cmp } from '../engine/order.mjs';
import { gitRoot } from './git.mjs';

export const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => cmp(a, b))) : v);
export const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function stampCollection(input, root, config, commit) {
  if (!input.collection) return input;
  const gitDir = gitRoot(root);
  const head = commit ?? (gitDir ? spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() : null);
  return { ...input, collection: { ...input.collection, config: digest(canonical(config)), ...(head ? { commit: head } : {}) } };
}
