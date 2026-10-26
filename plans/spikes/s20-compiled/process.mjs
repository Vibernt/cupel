import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

export function baseEnv(home) {
  return { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, LANG: 'C' };
}
