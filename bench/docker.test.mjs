import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerArgs } from './docker.mjs';

test('every Docker command creates the cache home before running', () => {
  const repo = { name: 'ruby-sample', dir: '/tmp/sample', runner: 'minitest', image: 'ruby:3-bookworm' };
  const args = dockerArgs(repo, 'none', 'set -eu; bundle exec rake test');
  assert.equal(args.at(-1), 'mkdir -p /cache/home && set -eu; bundle exec rake test');
  assert.ok(args.includes('BUNDLE_GEMFILE=/work/Gemfile'));
});
