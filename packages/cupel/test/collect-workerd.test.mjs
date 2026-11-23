// S30 / D18: per-test coverage of Worker code inside workerd, with the project's
// tests and files unchanged. Needs CUPEL_TEST_MINIFLARE (a package.json whose
// node_modules has Miniflare 5); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWorkerd, sameSource } from '../src/collect/node/workerd.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const miniflare = process.env.CUPEL_TEST_MINIFLARE;

test('workerd command lines and Miniflare source copies are recognised exactly', () => {
  assert.equal(isWorkerd('/x/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd', ['serve', '--binary', '-']), true);
  assert.equal(isWorkerd('C:\\x\\workerd.exe', ['serve']), true);
  assert.equal(isWorkerd('/usr/bin/node', ['serve']), false);
  assert.equal(isWorkerd('/x/workerd', ['compile']), false);
  assert.equal(sameSource('a();\n', 'a();\n'), true);
  assert.equal(sameSource('a();\n\n//# sourceURL=file:///w/src/a.mjs\n', 'a();\n'), true);
  assert.equal(sameSource('a();\nextra();\n', 'a();\n'), false);
  assert.equal(sameSource('/* bundled */a();\n', 'a();\n'), false);
});

test('each test gets exactly the Worker lines it ran in workerd; two runs agree', { skip: !miniflare && 'set CUPEL_TEST_MINIFLARE to a package.json with miniflare 5', timeout: 300_000 }, () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = realpathSync(mkdtempSync(join(repo, '.scratch/workerd-')));
  try {
    cpSync(join(repo, 'spec/conformance/adapters/workerd'), root, { recursive: true });
    const before = readFileSync(join(root, 'src/worker.mjs'), 'utf8');
    const out = join(root, '.cupel-out.json');
    const r = spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), 'collect-node', '--root', root, '--runs', '2', '--out', out],
      { cwd: root, env: { ...process.env, CUPEL_TEST_MINIFLARE: miniflare }, encoding: 'utf8', timeout: 280_000 });
    assert.equal(r.status, 0, r.stderr);
    const input = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(input.tests.map((t) => [t.id, t.status]), [['test/worker.test.mjs::doubles', 'passed'], ['test/worker.test.mjs::greets', 'passed']]);
    assert.deepEqual(input.coverage.byTest['test/worker.test.mjs::doubles'], { 'src/worker.mjs': '1-2,5-6,8,12-15,17-18' });
    assert.deepEqual(input.coverage.byTest['test/worker.test.mjs::greets'], { 'src/worker.mjs': '1,8-10,12-18' });
    assert.deepEqual(input.coverage.unstable, {});
    assert.equal(readFileSync(join(root, 'src/worker.mjs'), 'utf8'), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('faults in Worker code are tested inside workerd through a scratch copy; the project is never written', { skip: !miniflare && 'set CUPEL_TEST_MINIFLARE to a package.json with miniflare 5', timeout: 600_000 }, () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = realpathSync(mkdtempSync(join(repo, '.scratch/workerd-mut-')));
  const outDir = mkdtempSync(join(repo, '.scratch/workerd-mut-out-'));
  try {
    cpSync(join(repo, 'spec/conformance/adapters/workerd'), root, { recursive: true });
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { node: { tests: 'test/*.test.mjs' } }, tiers: { critical: ['src/**'] } }));
    const before = readFileSync(join(root, 'src/worker.mjs'), 'utf8');
    const out = join(outDir, 'input.json');
    const r = spawnSync(process.execPath, [join(repo, 'packages/cupel/bin/cupel.mjs'), 'report', '--runs', '1', '--out', out, '--json'],
      { cwd: root, env: { ...process.env, CUPEL_TEST_MINIFLARE: miniflare }, encoding: 'utf8', timeout: 580_000, maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(readFileSync(out, 'utf8')).mutation.mutants;
    const D = 'test/worker.test.mjs::doubles'; const G = 'test/worker.test.mjs::greets';
    assert.ok(rows.length >= 10, JSON.stringify(rows));
    assert.deepEqual(rows.filter((m) => m.status === 'survived').map((m) => [m.line, m.operator]), [[2, 'boundary']]);
    assert.deepEqual(rows.filter((m) => m.status === 'no-coverage').map((m) => m.line), [3]);
    assert.ok(rows.filter((m) => m.line === 5).every((m) => m.status === 'killed' && m.killedBy.join() === D));
    assert.ok(rows.filter((m) => m.line === 9).every((m) => m.status === 'killed' && m.killedBy.join() === G));
    assert.equal(readFileSync(join(root, 'src/worker.mjs'), 'utf8'), before);
    assert.equal(existsSync(join(root, '.scratch')), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }); }
});
