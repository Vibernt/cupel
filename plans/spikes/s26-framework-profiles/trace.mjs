// Ordinary fixture runtimes with a scratch-only API call counter preload.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const scratch = join(repo, '.scratch/s26-framework-profiles');
const preload = join(repo, 'plans/spikes/s26-framework-profiles/trace-preload.cjs');
const ordinary = JSON.parse(readFileSync(join(scratch, 'ordinary-summary.json'), 'utf8'));
const output = [];
for (const run of ordinary) {
  const root = run.root;
  const version = run.node;
  const node = version.startsWith('22.') ? '/opt/homebrew/opt/node@22/bin/node' : process.execPath;
  const home = join(root, `.trace-home-${version}`);
  mkdirSync(home, { recursive: true });
  const trace = join(home, 'calls.jsonl');
  writeFileSync(trace, '');
  const command = run.runner.startsWith('jest') ?
    [join(root, 'node_modules/jest/bin/jest.js'), '--no-cache'] :
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run'];
  const child = spawnSync(node, command, { cwd: root,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C',
      CUPEL_S26_TRACE: trace, NODE_OPTIONS: `--require=${preload}` },
    encoding: 'utf8', timeout: 45_000, maxBuffer: 2 << 20 });
  writeFileSync(join(home, 'run.out'), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
  const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const counts = Object.fromEntries([...new Set(calls.map(call => call.name))].sort()
    .map(name => [name, calls.filter(call => call.name === name).length]));
  output.push({ runner: run.runner, node: version, exit: child.status, signal: child.signal,
    timedOut: child.error?.code === 'ETIMEDOUT', counts, processes: new Set(calls.map(call => call.pid)).size,
    outputTail: `${child.stdout ?? ''}\n${child.stderr ?? ''}`.slice(-500) });
}
writeFileSync(join(scratch, 'runtime-summary.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.map(({ runner, node, exit, counts, processes }) => ({ runner, node, exit, counts, processes }))));
for (const row of output) {
  if (row.exit !== 0 || row.signal || row.timedOut) throw new Error(`traced ordinary ${row.runner} ${row.node} failed`);
  if (row.runner.startsWith('jest') && (!(row.counts['vm.compileFunction'] > 0) || row.processes !== 1))
    throw new Error(`Jest VM execution was not observed on ${row.node}`);
  if (row.runner.startsWith('vitest') && (!(row.counts['child_process.fork'] > 0) ||
      !(row.counts['vm.runInThisContext'] > 0) || row.processes !== 2))
    throw new Error(`Vitest fork or transformed VM execution was not observed on ${row.node}`);
}
