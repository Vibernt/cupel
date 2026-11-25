import { spawnSync } from 'node:child_process';

const EXPECTED_RELEASE = '1.97.1';
const EXPECTED_HOST = 'aarch64-apple-darwin';

export function restrictedRustProfile({ platform, arch, rustc, cargo, sysroot }) {
  const expected = 'Homebrew Rust/Cargo 1.97.1 on aarch64-apple-darwin';
  if (platform !== 'darwin' || arch !== 'arm64') {
    return { available: false, reason: `restricted Rust needs ${expected}; this host is ${platform}/${arch}` };
  }
  if (!rustc.includes(`release: ${EXPECTED_RELEASE}`) || !rustc.includes(`host: ${EXPECTED_HOST}`)) {
    return { available: false, reason: `restricted Rust needs ${expected}; rustc does not match that release and host` };
  }
  if (!new RegExp(`^cargo ${EXPECTED_RELEASE.replaceAll('.', '\\.')}(?:\\s|$)`).test(cargo.trim())) {
    return { available: false, reason: `restricted Rust needs ${expected}; cargo is not ${EXPECTED_RELEASE}` };
  }
  const normalized = sysroot.replaceAll('\\', '/');
  if (!new RegExp(`/Cellar/rust/${EXPECTED_RELEASE.replaceAll('.', '\\.')}(?:_\\d+)?(?:/|$)`).test(normalized)) {
    return { available: false, reason: `restricted Rust needs ${expected}; rustc is not from the Homebrew Cellar` };
  }
  return { available: true };
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.error || result.status !== 0 ? '' : result.stdout;
}

export function inspectRestrictedRustProfile() {
  return restrictedRustProfile({
    platform: process.platform,
    arch: process.arch,
    rustc: output('rustc', ['-vV']),
    cargo: output('cargo', ['--version']),
    sysroot: output('rustc', ['--print', 'sysroot']).trim(),
  });
}
