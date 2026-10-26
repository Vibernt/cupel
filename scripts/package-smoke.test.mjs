import { pythonPackageSmoke } from './python-package-smoke.mjs';
import { jestPackageSmoke } from './jest-package-smoke.mjs';
import { rubyPackageSmoke } from './ruby-package-smoke.mjs';
import { goPackageSmoke } from './go-package-smoke.mjs';
import { prPackageSmoke } from './pr-package-smoke.mjs';
import { rustPackageSmoke } from './rust-package-smoke.mjs';
import { createSmokeWorkspace } from './smoke-workspace.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGE = join(ROOT, 'packages/cupel');
const SCRATCH = createSmokeWorkspace(join(ROOT, '.scratch/package-smoke'));
const CASES = join(ROOT, 'spec/conformance/cases');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', npm_config_audit: 'false', npm_config_fund: 'false' },
    ...options,
  });
  assert.ifError(result.error);
  return result;
}

function checked(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result;
}

function caseFile(name, file) {
  return join(CASES, name, `${file}.json`);
}

test('npm tarball installs offline and runs CLI, guard, and MCP smoke checks', () => {
  const installRoot = join(SCRATCH, 'install');

  const packed = checked('npm', ['pack', '--offline', '--ignore-scripts', '--pack-destination', SCRATCH], { cwd: PACKAGE });
  const tarballName = packed.stdout.trim().split('\n').at(-1);
  assert.ok(tarballName?.endsWith('.tgz'), packed.stdout);
  const tarball = join(SCRATCH, tarballName);
  assert.ok(existsSync(tarball), `npm pack did not create ${tarball}`);

  const archive = checked('tar', ['-tzf', tarball]).stdout.split('\n');
  for (const asset of ['package/package.json', 'package/bin/cupel.mjs',
    'package/schemas/case.schema.json', 'package/schemas/config.schema.json',
    'package/schemas/input.schema.json', 'package/schemas/report.schema.json',
    'package/schemas/pr-result.schema.json', 'package/src/pr/request.mjs',
    'package/LICENSE', 'package/NOTICE',
    'package/ruby/bin/cupel-ruby', 'package/ruby/lib/cupel/runner.rb',
    'package/src/mutate-go/ast-helper/main.go']) {
    assert.ok(archive.includes(asset), `tarball is missing ${asset}`);
  }
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.version, '0.1.0');
  for (const legalFile of ['LICENSE', 'NOTICE']) {
    assert.deepEqual(readFileSync(join(PACKAGE, legalFile)), readFileSync(join(ROOT, legalFile)), `${legalFile} copy drifted`);
  }

  checked('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefix', installRoot, tarball]);
  const installedManifest = JSON.parse(readFileSync(join(installRoot,
    'node_modules/@vibernt/cupel/package.json'), 'utf8'));
  assert.equal(installedManifest.version, manifest.version);
  assert.equal(installedManifest.license, manifest.license);
  assert.equal(installedManifest.private, true);
  for (const legalFile of ['LICENSE', 'NOTICE']) {
    assert.deepEqual(readFileSync(join(installRoot, 'node_modules/@vibernt/cupel', legalFile)),
      readFileSync(join(ROOT, legalFile)), `installed ${legalFile} differs from the repository original`);
  }
  const bin = join(installRoot, 'node_modules/.bin/cupel');
  assert.ok(existsSync(bin), 'installed cupel executable is missing');

  const help = checked(bin, ['--help'], { cwd: SCRATCH });
  assert.match(help.stdout, /report\s+score every test/);
  assert.equal(checked(bin, ['--version'], { cwd: SCRATCH }).stdout, `${manifest.version}\n`);

  const input = caseFile('001-report-minimal', 'input');
  const report = checked(bin, ['report', '--input', input, '--no-mutation', '--json'], { cwd: SCRATCH });
  assert.equal(JSON.parse(report.stdout).spec, 'cupel-spec/1');

  const review = checked(bin, ['review', '--input', caseFile('064-review-basic-pack', 'input'), '--limit', '1', '--json'], { cwd: SCRATCH });
  assert.ok(JSON.parse(review.stdout).review);

  const passBase = caseFile('040-guard-pass', 'base');
  const passHead = caseFile('040-guard-pass', 'head');
  const guardPass = checked(bin, ['guard', '--base-input', passBase, '--head-input', passHead, '--json'], { cwd: SCRATCH });
  assert.equal(JSON.parse(guardPass.stdout).guard.pass, true);

  const failBase = caseFile('041-guard-coverage-lost', 'base');
  const failHead = caseFile('041-guard-coverage-lost', 'head');
  const guardFail = run(bin, ['guard', '--base-input', failBase, '--head-input', failHead, '--json'], { cwd: SCRATCH });
  assert.equal(guardFail.status, 1, guardFail.stderr);
  assert.equal(JSON.parse(guardFail.stdout).guard.pass, false);

  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cupel_report', arguments: { input } } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const mcp = checked(bin, ['mcp', '--root', ROOT], { cwd: SCRATCH, input: rpc });
  const replies = mcp.stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].result.serverInfo.name, 'cupel');
  assert.equal(replies[0].result.serverInfo.version, manifest.version);
  assert.equal(replies[1].result.isError, false);
  assert.ok(JSON.parse(replies[1].result.content[1].text).suite.units > 0);

  const summary = {
    artifact: tarball,
    installedBin: bin,
    runtime: process.version,
    version: installedManifest.version,
    checks: ['license-and-private-metadata', 'version', 'help', 'report', 'review', 'guard-pass', 'guard-negative', 'mcp-initialize-and-tool-call'],
    npmLicense: manifest.license,
    packagedLicenseFiles: archive.filter((path) => /package\/(LICENSE|NOTICE)$/i.test(path)),
    jest: jestPackageSmoke({ root: ROOT, scratch: SCRATCH, bin, checked }),
    ruby: rubyPackageSmoke({ scratch: SCRATCH, bin, checked }),
    go: goPackageSmoke({ root: ROOT, scratch: SCRATCH, bin, checked }),
    rust: rustPackageSmoke({ root: ROOT, scratch: SCRATCH, bin, checked }),
    pr: prPackageSmoke({ scratch: SCRATCH, bin, checked,
      nodePath: process.env.CUPEL_PR_NODE ?? process.execPath }),
    prOpaque: prPackageSmoke({ scratch: join(SCRATCH, 'opaque'), bin, checked,
      nodePath: process.env.CUPEL_PR_NODE ?? process.execPath,
      inputPolicy: 'express-root-npmrc-opaque-v1' }),
  };
  writeFileSync(join(SCRATCH, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
});

test('Python wheel builds and installs offline with pinned tooling', (t) => {
  pythonPackageSmoke({ root: ROOT, scratch: SCRATCH, checked, t });
});
