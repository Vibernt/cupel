import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restrictedRustProfile } from './restricted-rust-profile.mjs';

const valid = {
  platform: 'darwin', arch: 'arm64',
  rustc: 'rustc 1.97.1\nbinary: rustc\nhost: aarch64-apple-darwin\nrelease: 1.97.1\n',
  cargo: 'cargo 1.97.1 (example 2026-10-01)\n',
  sysroot: '/opt/homebrew/Cellar/rust/1.97.1',
};

test('restricted Rust accepts only the exact Homebrew Apple-silicon profile', () => {
  assert.deepEqual(restrictedRustProfile(valid), { available: true });
  assert.deepEqual(restrictedRustProfile({ ...valid, sysroot: '/opt/homebrew/Cellar/rust/1.97.1_1' }), { available: true });
  for (const changed of [
    { platform: 'linux' },
    { arch: 'x64' },
    { rustc: valid.rustc.replaceAll('1.97.1', '1.98.0') },
    { cargo: 'cargo 1.98.0' },
    { sysroot: '/Users/runner/.rustup/toolchains/1.97.1-aarch64-apple-darwin' },
  ]) {
    const result = restrictedRustProfile({ ...valid, ...changed });
    assert.equal(result.available, false);
    assert.match(result.reason, /Homebrew Rust\/Cargo 1\.97\.1 on aarch64-apple-darwin/);
  }
});
