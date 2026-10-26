import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summary } from '../../../action/summary.mjs';

const runner = fileURLToPath(new URL('../../../action/runner.mjs', import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function put(root, name, value) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function invoke(root, base, extra = {}) {
  const summaryFile = join(root, '.action-summary');
  writeFileSync(summaryFile, '');
  const r = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8',
    env: { ...env, NODE_ENV: 'test', CUPEL_TEST_COLLECTOR: '/missing/stub.mjs',
      CUPEL_BASE_COMMIT: base, CUPEL_APPROVALS_PATH: 'approvals.json',
      GITHUB_STEP_SUMMARY: summaryFile, ...extra }, timeout: 30000 });
  return { ...r, job: readFileSync(summaryFile, 'utf8') };
}

test('Action uses a real full guard and trusted base policy and approvals', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-action-test-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'package.json', '{"type":"module"}\n');
    put(root, 'cupel.json', JSON.stringify({ runners: { node: {} },
      tiers: { critical: ['tests/critical.test.mjs'] } }));
    put(root, 'approvals.json', '[]\n');
    put(root, 'src/auth.mjs', 'export function token() {\n  return 42;\n}\nexport function safe() {\n  return 7;\n}\n');
    put(root, 'tests/critical.test.mjs', "import { test } from 'node:test';\nimport { token } from '../src/auth.mjs';\ntest('token [critical]', () => { if (token() !== 42) throw Error('bad'); });\n");
    put(root, 'tests/normal.test.mjs', "import { test } from 'node:test';\nimport { safe, token } from '../src/auth.mjs';\ntest('safe', () => { if (safe() !== 7 || token() !== 42) throw Error('bad'); });\n");
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');

    const pass = invoke(root, base);
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.job, /Cupel guard: passed/);

    unlinkSync(join(root, 'tests/critical.test.mjs'));
    const failed = invoke(root, base);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.job, /\| critical-removed \| fail \|/);
    assert.match(failed.job, /\| coverage-ratio \| pass \|/);

    // A proposed PR cannot downgrade policy or forge approvals for its own deletion.
    put(root, 'cupel.json', JSON.stringify({ runners: { node: {} },
      tiers: { minor: ['tests/critical.test.mjs'] }, guard: { criticalCoverage: 0 } }));
    put(root, 'approvals.json', JSON.stringify([{ action: 'remove', id: 'tests/critical.test.mjs::token [critical]', by: 'forged' }]));
    const forged = invoke(root, base);
    assert.equal(forged.status, 1, forged.stderr);
    assert.match(forged.job, /\| critical-removed \| fail \|/);
    assert.match(forged.job, /\| coverage-ratio \| pass \|/);

    put(root, 'tests/normal.test.mjs', "import { test } from 'node:test';\nimport { safe } from '../src/auth.mjs';\ntest('safe', () => { if (safe() !== 7) throw Error('bad'); });\n");
    const lost = invoke(root, base);
    assert.equal(lost.status, 1, lost.stderr);
    assert.match(lost.job, /\| coverage-ratio \| fail \|/);

    const invalid = invoke(root, 'HEAD');
    assert.equal(invalid.status, 3);
    assert.match(invalid.stderr, /full 40- or 64-character/);
    const missing = invoke(root, 'f'.repeat(40));
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /git rev-parse failed/);
    const missingApproval = invoke(root, base, { CUPEL_APPROVALS_PATH: '.cupel/missing.json' });
    assert.equal(missingApproval.status, 3);
    assert.match(missingApproval.stderr, /trusted base lacks readable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Action summary bounds and escapes fields', () => {
  const result = summary({ guard: { checks: [{ id: '<bad|check>\n' }] },
    diagnostics: [{ code: 'x', message: 'a'.repeat(5000) }] }, 2);
  assert.ok(result.length <= 3501);
  assert.match(result, /&lt;bad\\\|check&gt;/);
  assert.doesNotMatch(result, /<bad/);
});

test('Action preserves CLI exit 2 for invalid trusted config', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-action-invalid-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'cupel.json', '{ invalid json');
    put(root, 'approvals.json', '[]\n');
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
    const result = invoke(root, git(root, 'rev-parse', 'HEAD'));
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.job, /invalid input/);
    assert.match(result.stderr, /not valid JSON/);
    unlinkSync(join(root, 'cupel.json'));
    unlinkSync(join(root, '.action-summary'));
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'missing config');
    const missingConfig = invoke(root, git(root, 'rev-parse', 'HEAD'));
    assert.equal(missingConfig.status, 3);
    assert.match(missingConfig.stderr, /trusted base lacks readable cupel.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Action preserves CLI environment errors and their actionable cause', () => {
  const root = mkdtempSync(join(tmpdir(), 'cupel-action-collector-error-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'package.json', '{"type":"module"}');
    put(root, 'cupel.json', JSON.stringify({ runners: { node: { tests: 'missing/**/*.test.mjs' } } }));
    put(root, 'approvals.json', '[]');
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
    const result = invoke(root, git(root, 'rev-parse', 'HEAD'));
    assert.equal(result.status, 3);
    assert.match(result.job, /environment error/);
    assert.match(result.stderr, /no test files match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
