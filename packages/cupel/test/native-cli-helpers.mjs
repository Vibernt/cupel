import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { main } from '../src/cli/main.mjs';

export function project(t, prefix) {
  const scratch = resolve('.scratch', 'cli-native-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, `${prefix}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export async function cli(root, args, expected = 0) {
  let stdout = '', stderr = '';
  const exit = await main(args, { cwd: root, env: process.env, colour: false,
    out: (part) => { stdout += part; }, err: (part) => { stderr += part; } });
  assert.equal(exit, expected, `cupel ${args.join(' ')}\n${stderr}\n${stdout}`);
  return { output: JSON.parse(stdout), stderr };
}

export function command(name, args, cwd) {
  const result = spawnSync(name, args, { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${name} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

export function gitBase(root) {
  command('git', ['init', '-q'], root);
  command('git', ['add', '.'], root);
  command('git', ['-c', 'user.name=Cupel Test', '-c', 'user.email=cupel-test@example.invalid',
    'commit', '-qm', 'base', '-m',
    'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'], root);
}

export function requireRuntime(t, kind) {
  const result = kind === 'go'
    ? spawnSync('go', ['version'], { encoding: 'utf8' })
    : spawnSync('ruby', ['-e', 'require "minitest"; print "#{RUBY_VERSION} #{Minitest::VERSION}"'], { encoding: 'utf8' });
  const valid = !result.error && result.status === 0 && (kind === 'go'
    ? /\bgo1\.27\.1\b/.test(result.stdout)
    : result.stdout.trim() === '4.0.7 6.0.0');
  if (valid) return;
  const message = `${kind} mutation needs ${kind === 'go' ? 'Go 1.27.1' : 'MRI Ruby 4.0.7 and Minitest 6.0.0'}`;
  if (process.env.CUPEL_REQUIRE_NATIVE_MUTATION === '1') assert.fail(message);
  t.skip(message);
}
