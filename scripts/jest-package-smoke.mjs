import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The runner is explicitly prepared test tooling, never installed by Cupel.
export function jestPackageSmoke({ root, scratch, bin, checked }) {
  const modules = process.env.CUPEL_JEST_MODULES ?? join(root, '.scratch/jest-runtime/node_modules');
  if (!existsSync(join(modules, 'jest/package.json'))) {
    if (process.env.CUPEL_REQUIRE_PACKAGE_SMOKE === '1') assert.fail('BLOCKED: prepare Jest 30.2.0 in .scratch/jest-runtime before installed-artifact acceptance');
    return { status: 'blocked', reason: 'Jest 30.2.0 test runtime is not prepared' };
  }
  assert.equal(JSON.parse(readFileSync(join(modules, 'jest/package.json'), 'utf8')).version, '30.2.0');
  const project = join(scratch, 'jest-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'tests'));
  symlinkSync(modules, join(project, 'node_modules'), 'dir');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, devDependencies: { jest: '30.2.0' } }));
  writeFileSync(join(project, 'jest.config.cjs'), "module.exports = { testEnvironment: 'node', transform: {}, testMatch: ['**/tests/*.test.cjs'] };\n");
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { jest: {} } }));
  writeFileSync(join(project, 'src/math.cjs'), 'exports.add = (a, b) => a + b;\n');
  writeFileSync(join(project, 'tests/math.test.cjs'), "const { add } = require('../src/math.cjs');\ntest('sum [critical]', () => expect(add(1, 2)).toBe(3));\n");
  checked('git', ['init', '-q'], { cwd: project });
  const out = join(project, '.scratch/input.json');
  const result = checked(bin, ['report', '--no-mutation', '--runs', '1', '--out', out, '--json'], { cwd: project });
  const report = JSON.parse(result.stdout);
  assert.equal(report.suite.tests, 1);
  assert.equal(report.suite.passed, 1);
  const input = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(input.coverage.byTest['tests/math.test.cjs::sum [critical]']['src/math.cjs']);
  const guard = checked(bin, ['guard', '--base-input', out, '--head-input', out, '--json'], { cwd: project });
  assert.equal(JSON.parse(guard.stdout).guard.pass, true);
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jest-package-smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cupel_report', arguments: {} } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const mcp = checked(bin, ['mcp', '--root', project], { cwd: project, input: rpc });
  const replies = mcp.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies[1].result.isError, false, mcp.stdout);
  assert.equal(JSON.parse(replies[1].result.content[1].text).suite.tests, 1);
  return { status: 'passed', version: '30.2.0', checks: ['installed-jest-collection', 'per-test-original-source-coverage', 'saved-input-guard', 'mcp-live-jest-collection'] };
}
