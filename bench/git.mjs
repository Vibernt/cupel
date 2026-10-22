// Host-side read-only commit selection. Archive extraction runs inside Docker.
import { runProcess } from './docker.mjs';
import { parseUnifiedDiff } from '../packages/cupel/src/cli/git.mjs';

const testFile = (p) => /(^|\/)(tests?|__tests__)\//.test(p) || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(p) || /(?:_test\.go|_test\.rb|test_.*\.py|Tests?\.cs)$/.test(p);
const sourceFile = (p) => /\.(?:[cm]?[jt]sx?|py|go|rs|cs|rb)$/.test(p) &&
  /(^|\/)(src|lib|pkg|cmd|internal|crates|apps|dev-server)\//.test(p) &&
  !testFile(p) && !/(^|\/)(dist|build|docs?|examples?|fixtures|vendor|node_modules|target)\//.test(p) &&
  !/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(p);
export { testFile, sourceFile };

async function git(repo, args) {
  const result = await runProcess('git', args, { cwd: repo.dir, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' } });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function recentCommits(repo, kind, limit) {
  const ids = (await git(repo, ['log', '--no-merges', '--format=%H', '-n', '500'])).trim().split('\n').filter(Boolean);
  const matches = [];
  for (const id of ids) {
    const paths = (await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', `${id}^`, id])).trim().split('\n').filter(Boolean);
    if (paths.some(kind === 'test' ? testFile : sourceFile)) matches.push({ commit: id, changedPaths: paths });
    if (matches.length === limit) break;
  }
  return matches;
}

export async function commitChangedLines(repo, commit) {
  const diff = await git(repo, ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-renames', `${commit}^`, commit, '--']);
  return Object.fromEntries(Object.entries(parseUnifiedDiff(diff)).filter(([path]) => sourceFile(path)));
}
