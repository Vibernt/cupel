import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('hosted CI has the requested triggers, matrix, permissions and cancellation', () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /\n\s+pull_request:\n/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /node: \['22\.23\.3', '26\.7\.0'\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /timeout-minutes: 60/);
});

test('hosted CI prepares every pinned runtime and makes acceptance gates mandatory', () => {
  for (const text of [
    "node-version: '22.23.3'", "node-version: '26.7.0'", "go-version: '1.27.1'",
    "ruby-version: '4.0.7'", "python-version: '3.14'", 'pytest==9.1.1',
    'setuptools==80.9.0', 'rustup toolchain install 1.97.1',
    'cargo-mutants --version 27.1.0', 'vitest-4", "4.1.11"', 'vitest-5", "5.0.1"',
    'miniflare: "5.20261101.0-beta"', 'npm ci --prefix spec/conformance/adapters/jest',
  ]) assert.ok(workflow.includes(text), `workflow is missing ${text}`);

  for (const flag of [
    'CUPEL_REQUIRE_NATIVE_MUTATION', 'CUPEL_REQUIRE_JEST', 'CUPEL_REQUIRE_PACKAGE_SMOKE',
    'CUPEL_REQUIRE_RUBY_SMOKE', 'CUPEL_REQUIRE_GO_SMOKE', 'CUPEL_CARGO_MUTANTS',
    'CUPEL_TEST_MINIFLARE', 'CUPEL_TEST_NODE22', 'CUPEL_TEST_NODE26', 'CUPEL_PR_NODE',
    'CUPEL_TEST_PYTHON', 'CUPEL_PACKAGE_PYTHON', 'CUPEL_PACKAGE_WHEELS', 'CUPEL_JEST_MODULES',
    'CUPEL_TEST_VITEST4_MODULES', 'CUPEL_TEST_VITEST5_MODULES',
  ]) assert.ok(workflow.includes(flag), `workflow is missing ${flag}`);
  assert.doesNotMatch(workflow, /CUPEL_REQUIRE_RESTRICTED_RUST:\s*'1'/);
});

test('hosted CI runs every repository suite and preserves failure output', () => {
  for (const command of [
    'npm run -s check', 'npm test', 'npm run -s test:py', 'npm run -s test:ruby',
    'python -m pytest -q tests',
  ]) assert.ok(workflow.includes(command), `workflow is missing ${command}`);
  // The installed-package smoke is part of npm test (scripts/**/*.test.mjs); a second explicit run would double it.
  assert.ok(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts.test.includes('scripts/**/*.test.mjs'));
  assert.match(workflow, /if: failure\(\)[\s\S]*actions\/upload-artifact@v4/);
});
