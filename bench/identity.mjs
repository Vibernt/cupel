import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { runProcess, dockerRun } from './docker.mjs';

const root = resolve(import.meta.dirname, '..');
const commands = { vitest: 'node --version', node: 'node --version', pytest: 'python --version',
  go: 'go version', cargo: 'rustc --version', dotnet: 'dotnet --version', minitest: 'ruby --version' };

async function gitValue(cwd, args) {
  const result = await runProcess('git', args, { cwd, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' } });
  if (result.exitCode !== 0) throw new Error(`git identity failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function revision(cwd) {
  const [commit, changes, untracked] = await Promise.all([
    gitValue(cwd, ['rev-parse', 'HEAD']),
    gitValue(cwd, ['status', '--porcelain', '--untracked-files=no']),
    gitValue(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return { commit, dirty: Boolean(changes || untracked) };
}

export async function measurementIdentity(repo) {
  const [candidate, cupel, probe, image] = await Promise.all([
    revision(repo.dir), revision(root), dockerRun(repo, 'none', commands[repo.runner]),
    runProcess('docker', ['image', 'inspect', '--format', '{{.Id}}', repo.image]),
  ]);
  if (probe.exitCode !== 0 || probe.signal) throw new Error(`${repo.runner} runtime identity failed: ${probe.stderr || probe.stdout}`);
  if (image.exitCode !== 0 || image.signal || !image.stdout.trim()) throw new Error(`image identity failed: ${image.stderr || image.stdout}`);
  return {
    candidateRevision: candidate.commit, candidateDirty: candidate.dirty,
    cupelRevision: cupel.commit, cupelDirty: cupel.dirty,
    configHash: createHash('sha256').update(JSON.stringify({ runner: repo.runner, test: repo.test, config: repo.cupelConfig })).digest('hex'),
    image: repo.image, imageId: image.stdout.trim(), runtime: probe.stdout.trim() || probe.stderr.trim(),
  };
}
