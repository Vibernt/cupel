import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cacheEnv, dockerArgs, dockerBuildArgs } from './docker.mjs';

test('every Docker command creates the cache home before running', () => {
  const repo = { name: 'ruby-sample', dir: '/tmp/sample', runner: 'minitest', image: 'ruby:3-bookworm' };
  const args = dockerArgs(repo, 'none', 'set -eu; bundle exec rake test');
  assert.equal(args.at(-1), 'mkdir -p /cache/home && set -eu; bundle exec rake test');
  assert.ok(args.includes('BUNDLE_GEMFILE=/work/gemfiles/rails8.gemfile'));
  assert.ok(dockerArgs(repo, 'none', 'bundle exec rake test', '/work/base').includes('BUNDLE_GEMFILE=/work/base/gemfiles/rails8.gemfile'));
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

test('Cargo toolchain and LLVM component persist in the cache volume', () => {
  const env = cacheEnv({ runner: 'cargo' });
  assert.equal(env.RUSTUP_HOME, '/cache/rustup');
  assert.equal(env.CARGO_HOME, '/cache/cargo');
});

test('Tauri benchmark keeps Rust tools in cache and uses a built image', () => {
  const repos = JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8'));
  const repo = repos.find((item) => item.name === 'locally-uncensored');
  const env = cacheEnv(repo);
  assert.equal(repo.imageBuild, 'images/locally-uncensored.Dockerfile');
  assert.equal(env.CARGO_HOME, '/cache/cargo');
  assert.equal(env.RUSTUP_HOME, '/cache/rustup');
  assert.ok(env.PATH.split(':').includes('/cache/cargo/bin'));
  assert.equal(repo.cupelConfig.runners.cargo.project, 'src-tauri');
  assert.match(repo.install, /llvm-tools-preview/);
  assert.match(repo.install, /\(cd src-tauri && .*cargo fetch --locked\)/);
  assert.match(repo.install, /mkdir -p src-tauri\/bin src-tauri\/resources\/llama\/\$triple dist/);
  assert.deepEqual(dockerBuildArgs(repo, '/bench'), ['build', '--platform', 'linux/arm64', '-t', repo.image, '-f', '/bench/images/locally-uncensored.Dockerfile', '/bench']);
});

test('mixed benchmark repositories configure both collected suites', () => {
  const repos = JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8'));
  for (const [name, runners] of Object.entries({
    'github-mcp-server': ['go', 'node'], 'zotero-mcp': ['pytest', 'node'],
    activeagent: ['minitest', 'node'], 'locally-uncensored': ['vitest', 'cargo'],
  })) {
    const repo = repos.find((item) => item.name === name);
    assert.deepEqual(Object.keys(repo.cupelConfig.runners), runners, name);
    assert.ok(repo.install, `${name} needs an install recipe`);
  }
  const ruby = repos.find((item) => item.name === 'activeagent');
  assert.match(ruby.install, /bundle_file=\$PWD\/gemfiles\/rails8\.gemfile/);
  assert.match(ruby.install, /cd \.\.\/\.\. && cd actionagent\/frontend/);
});
