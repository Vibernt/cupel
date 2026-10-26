import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactGitBaseline, assertExactGitHead } from '../../../packages/cupel/src/pr/git-identity.mjs';
import { copyLockedPackages, copyManifest, readPinnedFile } from './copy-safe.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const lane = join(repo, '.scratch/s12b/real-lane');
const original = join(lane, 'express');
const scratch = join(repo, '.scratch/s23');
const upstreamCommit = '4ca3fa8701629a4eb27c76a69aa6d6e294290b40';
const inputPolicy = 'express-root-npmrc-opaque-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const excludedTsx = Object.freeze([
  'src/components/patterns/Searchbox/Chat.tsx',
  'src/components/patterns/Searchbox/ChatActions.tsx',
  'src/components/patterns/Searchbox/ChatSources.tsx',
  'src/components/patterns/Searchbox/Search.tsx',
  'src/components/patterns/Searchbox/SearchFooter.tsx',
  'src/components/patterns/Searchbox/SearchNoResults.tsx',
  'src/components/patterns/Searchbox/Searchbox.tsx',
]);
const config = { scope: { exclude: [...excludedTsx] },
  runners: { node: { tests: 'tests/unit/*.test.mjs' } } };
const env = { PATH: process.env.PATH ?? '', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20, env });
  if (result.error || result.status !== 0)
    throw new Error(`derived fixture Git failed: ${args[0]}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function commit(root, paths, title) {
  git(root, 'add', '-f', '--', ...paths.map(path => `:(literal)${path}`));
  git(root, '-c', 'user.name=Cupel Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', title, '-m',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  return git(root, 'rev-parse', 'HEAD');
}

/** Derive a fresh complete Express lane without reading the original opaque file. */
export function deriveExpress() {
  const originalEvidence = assertExactGitBaseline({ root: original,
    commit: upstreamCommit, inputPolicy });
  if (originalEvidence.opaqueRootNpmrc !== 'regular' ||
      Object.hasOwn(originalEvidence.inputManifest, '.npmrc'))
    throw new Error('Express opaque source did not meet metadata-only preflight');
  const setup = JSON.parse(readFileSync(join(lane, 'setup.json'), 'utf8'));
  const faults = JSON.parse(readFileSync(join(lane, 'faults.json'), 'utf8'));
  if (setup.sourceCommit !== upstreamCommit ||
      `sha256:${setup.lockSha256}` !== originalEvidence.inputManifest['package-lock.json'])
    throw new Error('Express lock or upstream fixture identity differs');
  if (Object.hasOwn(originalEvidence.inputManifest, 'cupel.json'))
    throw new Error('Express original unexpectedly already declares Cupel config');
  const actualTsx = Object.keys(originalEvidence.inputManifest)
    .filter(path => path.endsWith('.tsx')).sort();
  if (JSON.stringify(actualTsx) !== JSON.stringify([...excludedTsx].sort()))
    throw new Error('Express declared TSX exclusion differs from exact seven known paths');
  mkdirSync(scratch, { recursive: true });
  const runDir = mkdtempSync(join(scratch, 'express-derived-'));
  const baseRoot = join(runDir, 'base');
  mkdirSync(baseRoot);
  const copied = copyManifest(original, baseRoot, originalEvidence.inputManifest);
  // This known empty placeholder is a new derived Git blob. Original .npmrc
  // contents are neither copied nor opened; the subject still exercises the
  // explicit opaque presence and access-denial policy.
  writeFileSync(join(baseRoot, '.npmrc'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(baseRoot, 'cupel.json'), `${JSON.stringify(config)}\n`,
    { flag: 'wx', mode: 0o600 });
  const packages = copyLockedPackages(original, baseRoot, setup);
  git(baseRoot, 'init', '-q');
  const baseCommit = commit(baseRoot,
    [...Object.keys(originalEvidence.inputManifest), '.npmrc', 'cupel.json'],
    'Derived complete Express lane');
  const baseEvidence = assertExactGitBaseline({ root: baseRoot,
    commit: baseCommit, inputPolicy });
  const cases = {};
  for (const [name, fault] of Object.entries(faults)) {
    if (fault.sourceCommit !== upstreamCommit || fault.changedFiles.length !== 1 ||
        fault.changedFiles[0] !== fault.changedPath ||
        originalEvidence.inputManifest[fault.changedPath] !== `sha256:${fault.beforeSha256}`)
      throw new Error(`Express fault metadata differs: ${name}`);
    const caseRoot = join(runDir, name);
    cpSync(baseRoot, caseRoot, { recursive: true, force: false, errorOnExist: true });
    const { bytes } = readPinnedFile(join(lane, name), fault.changedPath, fault.afterSha256);
    writeFileSync(join(caseRoot, fault.changedPath), bytes);
    const headCommit = commit(caseRoot, [fault.changedPath], `Derived ${name} source fault`);
    const head = assertExactGitHead({ root: caseRoot, baseCommit, inputPolicy });
    if (head.commit !== headCommit || head.inputManifest[fault.changedPath] !==
        `sha256:${fault.afterSha256}`)
      throw new Error(`Express derived fault did not bind exact HEAD: ${name}`);
    cases[name] = { root: caseRoot, headCommit,
      changedPath: fault.changedPath, sourceSha256: fault.afterSha256 };
  }
  const summary = { kind: 's23-derived-express/1', runDir, original,
    originalCommit: upstreamCommit, originalTrackedFiles: originalEvidence.fileCount,
    originalOpaque: { present: true, tracked: true, contentRead: false },
    copied, packages, config, inputPolicy, baseRoot, baseCommit,
    excludedTsx: [...excludedTsx],
    baseTrackedFiles: baseEvidence.fileCount,
    baseManifestHash: sha(Buffer.from(JSON.stringify(baseEvidence.inputManifest))),
    originalManifestHash: sha(Buffer.from(JSON.stringify(originalEvidence.inputManifest))),
    cases };
  writeFileSync(join(runDir, 'derivation.json'), `${JSON.stringify(summary, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 });
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(deriveExpress()));
