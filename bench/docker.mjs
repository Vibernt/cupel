import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const cupelRoot = resolve(import.meta.dirname, '..');

export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

export function runProcess(program, args, { cwd, env = process.env, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolveResult, reject) => {
    const started = performance.now();
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const collect = (key) => (chunk) => {
      if (key === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > maxBytes) child.kill('SIGKILL');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', reject);
    child.on('close', (code, signal) => resolveResult({ exitCode: code ?? 128, signal, wallMs: Math.round(performance.now() - started), stdout, stderr }));
  });
}

export function cacheEnv(repo) {
  const common = { HOME: '/cache/home', TMPDIR: '/tmp', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' };
  if (repo.runner === 'pytest') return { ...common, PATH: '/cache/node/node_modules/node/bin:/cache/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', PYTHONPATH: '/cupel/packages/cupel-py/src', PIP_CACHE_DIR: '/cache/pip' };
  if (repo.runner === 'go') return { ...common, GOPATH: '/cache/go', GOCACHE: '/cache/go-build', GOTOOLCHAIN: 'auto' };
  if (repo.runner === 'cargo') return { ...common, CARGO_HOME: '/cache/cargo', CARGO_TARGET_DIR: '/cache/target' };
  if (repo.runner === 'dotnet') return { ...common, NUGET_PACKAGES: '/cache/nuget', DOTNET_CLI_HOME: '/cache/home' };
  if (repo.runner === 'minitest') return { ...common, BUNDLE_PATH: '/cache/bundle', RAILS_ENV: 'test', CI: 'true' };
  return { ...common, npm_config_cache: '/cache/npm', COREPACK_HOME: '/cache/corepack', HUSKY: '0' };
}

export function dockerArgs(repo, network, command, workdir = '/work') {
  if (!['bridge', 'none'].includes(network)) throw new Error('network must be bridge or none');
  const args = ['run', '--rm', '--platform', 'linux/arm64', '--network', network,
    '-v', `${repo.dir}:/work`, '-v', `${cupelRoot}:/cupel:ro`, '-v', `cupel-bench-${repo.name.toLowerCase().replaceAll('_', '-')}-cache:/cache`, '-w', workdir];
  for (const [key, value] of Object.entries(cacheEnv(repo))) args.push('-e', `${key}=${value}`);
  args.push(repo.image, 'sh', '-c', command);
  return args;
}

export function dockerRun(repo, network, command, workdir) {
  return runProcess('docker', dockerArgs(repo, network, command, workdir));
}

export function cupelCommand(repo, verb, options = '', timed = false) {
  const base = `node /cupel/packages/cupel/bin/cupel.mjs ${verb} ${options}`;
  return timed ? `if [ -x /usr/bin/time ]; then /usr/bin/time -v ${base}; else ${base}; fi` : base;
}
