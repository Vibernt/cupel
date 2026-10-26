import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { collectNode } from '../../../packages/cupel/src/collect/node/index.mjs';
import { collectVitest } from '../../../packages/cupel/src/collect/vitest/index.mjs';
import { collectJest } from '../../../packages/cupel/src/collect/jest/index.mjs';
import { linkVitestModules } from '../../../packages/cupel/test/vitest-modules.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const vitestModules = '/Users/vid/codecrystal/hub-ts/node_modules';
const jestModules = join(repo, '.scratch/jest-runtime/node_modules');
export const python = join(repo, '.scratch/package-tools/runtime/bin/python');
const pySrc = join(repo, 'packages/cupel-py/src');

export function runnerInfo(runner) {
  if (runner === 'node') return { version: process.versions.node, runtime: process.versions.node,
    command: process.execPath };
  if (runner === 'vitest' || runner === 'jest') {
    const modules = runner === 'vitest' ? vitestModules : jestModules;
    const path = join(modules, runner, 'package.json');
    if (!existsSync(path)) throw new Error(`${runner} runtime missing: ${path}`);
    return { version: JSON.parse(readFileSync(path, 'utf8')).version,
      runtime: process.versions.node, command: join(modules, runner) };
  }
  if (runner === 'pytest') {
    const probe = spawnSync(python, ['-c', 'import pytest,platform;print(pytest.__version__,platform.python_version())'],
      { encoding: 'utf8', env: { PYTHONNOUSERSITE: '1', PATH: '/usr/bin:/bin' } });
    if (probe.status !== 0) throw new Error(`pytest unavailable: ${probe.stderr}`);
    const [version, runtime] = probe.stdout.trim().split(' ');
    return { version, runtime, command: python };
  }
  throw new Error(`unsupported runner: ${runner}`);
}

export function prepare(runner, root) {
  if (runner === 'vitest') linkVitestModules(root, vitestModules);
  if (runner === 'jest') symlinkSync(jestModules, join(root, 'node_modules'), 'dir');
}

export function execute(runner, root, files = [], nodePath = process.execPath) {
  let command; let args;
  const env = { CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: 'C',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin', PYTHONNOUSERSITE: '1' };
  if (runner === 'node') { command = nodePath; args = ['--test', '--test-reporter=tap',
    ...(files.length ? files : readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`))]; }
  else if (runner === 'vitest') { command = process.execPath; args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files]; }
  else if (runner === 'jest') { command = process.execPath; args = [join(root, 'node_modules/jest/bin/jest.js'), '--runInBand', '--no-cache', ...files]; }
  else if (runner === 'pytest') { command = python; args = ['-m', 'pytest', '-q', ...files];
    env.PYTHONPATH = [join(root, 'src'), pySrc, root].join(':'); }
  else throw new Error(`unsupported runner ${runner}`);
  const start = performance.now();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const failed = runner === 'node' ? Number([...output.matchAll(/^# fail (\d+)/gm)].at(-1)?.[1] ?? NaN) :
    runner === 'vitest' ? Number([...output.matchAll(/Tests\s+.*?(\d+) failed/g)].at(-1)?.[1] ??
      [...output.matchAll(/Test Files\s+.*?(\d+) failed/g)].at(-1)?.[1] ?? (result.status === 0 ? 0 : NaN)) :
      runner === 'jest' ? Number([...output.matchAll(/Tests:\s+.*?(\d+) failed/g)].at(-1)?.[1] ??
        [...output.matchAll(/Test Suites:\s+.*?(\d+) failed/g)].at(-1)?.[1] ?? (result.status === 0 ? 0 : NaN)) :
        Number([...output.matchAll(/(\d+) failed/g)].at(-1)?.[1] ??
          [...output.matchAll(/(\d+) errors?/g)].at(-1)?.[1] ?? (result.status === 0 ? 0 : NaN));
  const outcome = result.error || !Number.isFinite(failed) ? 'error' : failed > 0 ? 'fail' : result.status === 0 ? 'pass' : 'error';
  return { outcome, failed: Number.isFinite(failed) ? failed : null, exit: result.status,
    wallMs: Math.round(performance.now() - start), output, error: result.error?.message ?? null };
}

export async function collect(runner, root) {
  if (runner === 'node') return collectNode({ root, runs: 1 });
  if (runner === 'vitest') return collectVitest({ root, runs: 1 });
  if (runner === 'jest') return collectJest({ root, config: { runners: { jest: {} } }, runs: 1,
    recheck: [], log: () => {} });
  const out = join(root, '.scratch/input.json');
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const result = spawnSync(python, ['-m', 'vibernt_cupel', 'collect', '--root', root, '--runs', '1', '--out', out],
    { cwd: root, env: { PYTHONNOUSERSITE: '1', PATH: '/usr/bin:/bin',
      PYTHONPATH: [join(root, 'src'), pySrc, root].join(':') }, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0 || !existsSync(out)) throw new Error(`pytest collection failed: ${result.stderr || result.stdout}`);
  return JSON.parse(readFileSync(out, 'utf8'));
}
