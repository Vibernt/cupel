import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheEnv, dockerArgs } from './docker.mjs';

test('every Docker command creates the cache home before running', () => {
  const repo = { name: 'ruby-sample', dir: '/tmp/sample', runner: 'minitest', image: 'ruby:3-bookworm' };
  const args = dockerArgs(repo, 'none', 'set -eu; bundle exec rake test');
  assert.equal(args.at(-1), 'mkdir -p /cache/home && set -eu; bundle exec rake test');
  assert.ok(args.includes('BUNDLE_GEMFILE=/work/gemfiles/rails8.gemfile'));
});

test('toolchain runners preserve their image toolchain and cached Node on PATH', () => {
  const paths = {
    go: ['/usr/local/go/bin', '/cache/go/bin'],
    cargo: ['/usr/local/cargo/bin'],
    minitest: ['/usr/local/bundle/bin'],
    dotnet: ['/usr/share/dotnet'],
  };
  for (const [runner, required] of Object.entries(paths)) {
    const path = cacheEnv({ runner }).PATH.split(':');
    for (const directory of ['/cache/node/node_modules/node/bin', ...required]) {
      assert.ok(path.includes(directory), `${runner} PATH lacks ${directory}`);
    }
  }
});
