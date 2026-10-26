import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
export const project = resolve(here, '../../..');
export const oldScratch = join(project, '.scratch/s12b/real-lane');
export const baseRoot = join(oldScratch, 'express');
export const baseCommit = '4ca3fa8701629a4eb27c76a69aa6d6e294290b40';
export const inputPolicy = 'express-root-npmrc-opaque-v1';
export const files = [
  'tests/unit/rehype-accessible-tables.test.mjs',
  'tests/unit/rehype-rewrite-localized-links.test.mjs',
  'tests/unit/remark-code-tabs.test.mjs',
  'tests/unit/remark-rewrite-localized-links.test.mjs',
];
export const cases = [
  { name: 'accessible', root: join(oldScratch, 'case-accessible'),
    changed: 'src/plugins/rehype-accessible-tables.mjs', failures: 4, selectedFiles: 2 },
  { name: 'code-tabs', root: join(oldScratch, 'case-code-tabs'),
    changed: 'src/plugins/remark-code-tabs.mjs', failures: 8, selectedFiles: 1 },
];
export const fixedEnv = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C' };

export function assertPinnedMetadata(root) {
  const git = args => {
    const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000,
      env: { ...fixedEnv, PATH: '/usr/bin:/bin:/opt/homebrew/bin',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (run.status !== 0 || run.error) throw new Error('pinned public Git metadata query failed');
    return run.stdout.trim();
  };
  const commit = git(['rev-parse', 'HEAD']);
  const opaqueStage = git(['ls-files', '--stage', '--', '.npmrc']);
  if (commit !== baseCommit || !/^100644 [0-9a-f]{40} 0\t\.npmrc$/.test(opaqueStage))
    throw new Error('public source commit or tracked opaque descriptor differs');
  return { commit, opaqueStage };
}

export function collectorInput() {
  const input = JSON.parse(readFileSync(join(oldScratch, 'collector-input.json'), 'utf8'));
  if (input.tests?.length !== 65 ||
    JSON.stringify([...new Set(input.tests.map(row => row.file))].sort()) !== JSON.stringify(files))
    throw new Error('original collector inventory is not the complete 65-test lane');
  return input;
}
