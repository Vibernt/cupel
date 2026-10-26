import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectJest } from '../src/collect/jest/index.mjs';
import { executeJest, resolveJest } from '../src/collect/jest/process.mjs';
import { mutateNode } from '../src/mutate/index.mjs';
import { match } from '../src/conformance/match.mjs';
import { main } from '../src/cli/main.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = join(repo, 'packages/cupel/bin/cupel.mjs');
const fixture = join(repo, 'spec/conformance/adapters/jest');
const hasJest = existsSync(join(fixture, 'node_modules/jest/package.json'));
const skip = hasJest ? false : 'install the pinned Jest fixture with npm ci --prefix spec/conformance/adapters/jest';
const sourceHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function project() {
  mkdirSync(join(repo, '.scratch'), { recursive:true });
  const root = mkdtempSync(join(repo, '.scratch/jest-test-'));
  for (const name of ['package.json', 'jest.config.cjs', 'transform.cjs', 'src/math.cjs', 'src/typed.ts',
    'tests/math.test.cjs', 'tests/typed.test.ts']) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive:true });
    copyFileSync(join(fixture, name), target);
  }
  symlinkSync(join(fixture, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

test('Jest release gate fixture is installed when required', { skip:process.env.CUPEL_REQUIRE_JEST !== '1' }, () => {
  assert.ok(hasJest, 'run npm ci --prefix spec/conformance/adapters/jest');
});

test('Jest runtime collector proves IDs, boundaries, maps, concurrency and fresh exact rechecks', { skip }, async () => {
  const input = await collectJest({ root:fixture, runs:2,
    recheck:['tests/math.test.cjs::math > step %i', 'tests/math.test.cjs::math > duplicate #2'] });
  const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
  assert.deepEqual(match(expected, input), []);
  assert.deepEqual(input.coverage.rechecked,
    ['tests/math.test.cjs::math > duplicate #2', 'tests/math.test.cjs::math > step %i']);
  assert.deepEqual(input.tests.map(row => row.runStatuses), Array.from({length:8}, () => ['passed','passed']));
  assert.equal(input.coverage.byTest['tests/typed.test.ts::source text pin']['src/typed.ts'], undefined);
  assert.equal(input.coverage.byTest['tests/typed.test.ts::transformed source map']['src/typed.ts'], '1-4');
  assert.equal(input.coverage.byTest['tests/math.test.cjs::math > concurrent one']['src/math.cjs'],
    input.coverage.byTest['tests/math.test.cjs::math > concurrent two']['src/math.cjs']);
  assert.ok(input.shapes['tests/math.test.cjs::math > step %i'].length > 0);
  assert.deepEqual(input.brittleness, [{test:'tests/typed.test.ts::source text pin', kind:'source-text', line:4}]);
});

test('Jest in-memory TypeScript mutant is killed by behavior, never by source-text pin', { skip }, async () => {
  const path = join(fixture, 'src/typed.ts');
  const before = sourceHash(path);
  const input = await collectJest({ root:fixture, runs:2 });
  const mutation = await mutateNode({ root:fixture, input, config:{ mutation:{ maxMutants:2, maxSeconds:60 } },
    scope:{ targeted:['tests/typed.test.ts::transformed source map'] }, collectorKind:'jest' });
  assert.equal(mutation.mutants.length, 2);
  assert.ok(mutation.mutants.every(mutant => mutant.status === 'killed'));
  assert.ok(mutation.mutants.every(mutant =>
    mutant.killedBy?.includes('tests/typed.test.ts::transformed source map') &&
    !mutant.killedBy?.includes('tests/typed.test.ts::source text pin')));
  assert.equal(sourceHash(path), before);
});

test('Jest CLI report and guard collect with the project-owned runner', { skip }, async () => {
  const root = project();
  try {
    const base = join(root, 'base.json');
    const output = [];
    const io = { cwd:root, env:process.env, colour:false, out:text => output.push(text), err:text => output.push(text) };
    assert.equal(await main(['label', '--runs','2', '--out',base], io), 0);
    const saved = JSON.parse(readFileSync(base, 'utf8'));
    assert.equal(saved.runtimes[0].runner, 'jest');
    assert.equal(saved.tests.length, 8);
    assert.equal(await main(['guard', '--base-input',base, '--no-mutation', '--runs','2'], io), 0);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest guard resolves a zero-mutant Git baseline before its temporary tree closes', { skip }, () => {
  const root = project();
  try {
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.scratch\n.cupel\n');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd:root }).status, 0);
    assert.equal(spawnSync('git', ['add', '--', '.gitignore', 'package.json', 'jest.config.cjs',
      'transform.cjs', 'src/math.cjs', 'src/typed.ts', 'tests/math.test.cjs', 'tests/typed.test.ts'],
    { cwd:root }).status, 0);
    const commit = spawnSync('git', ['-c', 'user.name=Cupel Smoke', '-c', 'user.email=cupel-smoke@example.invalid',
      'commit', '-q', '-m', 'Jest baseline fixture',
      '-m', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'], { cwd:root, encoding:'utf8' });
    assert.equal(commit.status, 0, commit.stderr);

    const guard = spawnSync(process.execPath, [bin, 'guard', '--base', 'HEAD', '--runs', '1', '--json'],
      { cwd:root, encoding:'utf8', timeout:120_000 });
    assert.ifError(guard.error);
    assert.equal(guard.status, 0, `${guard.stderr}\n${guard.stdout}`);
    assert.match(guard.stderr, /mutate: 0 generated/);
    assert.equal(JSON.parse(guard.stdout).guard.pass, true);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest CLI report runs critical mutation through the project transformer', { skip }, async () => {
  const root = project();
  try {
    const typed = join(root, 'src/typed.ts');
    const auth = join(root, 'src/auth.ts');
    copyFileSync(typed, auth);
    const testFile = join(root, 'tests/typed.test.ts');
    writeFileSync(testFile, readFileSync(testFile, 'utf8').replaceAll('typed.ts', 'auth.ts'));
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ mutation:{maxMutants:1,maxSeconds:60} }));
    const before = sourceHash(auth);
    const output = join(root, 'report-input.json');
    const code = await main(['report','--runs','2','--out',output],
      { cwd:root, env:process.env, colour:false, out:()=>{}, err:()=>{} });
    assert.equal(code, 0);
    const input = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(input.runtimes[0].runner, 'jest');
    assert.equal(input.mutation.mutants.length, 1);
    assert.equal(input.mutation.mutants[0].status, 'killed');
    assert.ok(!input.mutation.mutants[0].killedBy.includes('tests/typed.test.ts::source text pin'));
    assert.equal(sourceHash(auth), before);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects a non-node environment before collection', { skip }, async () => {
  const root = project();
  try {
    writeFileSync(join(root, 'jest.config.cjs'), "module.exports = { testEnvironment: './custom-environment.cjs', testRunner: 'jest-circus/runner' };\n");
    writeFileSync(join(root, 'custom-environment.cjs'), "module.exports = require('jest-environment-node').TestEnvironment;\n");
    await assert.rejects(collectJest({root,runs:1}), /testEnvironment must be the project-owned node environment/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects a custom environment whose filename imitates the node environment', { skip }, async () => {
  const root = project();
  try {
    writeFileSync(join(root, 'jest.config.cjs'), "module.exports = { testEnvironment: './fake-jest-environment-node.cjs', testRunner: 'jest-circus/runner' };\n");
    writeFileSync(join(root, 'fake-jest-environment-node.cjs'), "module.exports = require('jest-environment-node').TestEnvironment;\n");
    await assert.rejects(collectJest({root,runs:1}), /testEnvironment must be the project-owned node environment/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects a per-file environment docblock before running tests', { skip }, async () => {
  const root = project();
  try {
    const file = join(root, 'tests/math.test.cjs');
    writeFileSync(file, '/** @jest-environment jsdom */\n' + readFileSync(file, 'utf8'));
    await assert.rejects(collectJest({root,runs:1}), /per-file environment docblock is unsupported/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects unresolved parameterized registration through a helper', { skip }, async () => {
  const root = project();
  try {
    writeFileSync(join(root, 'tests/math.test.cjs'), "require('./helper.cjs');\n");
    writeFileSync(join(root, 'tests/helper.cjs'), "test.each([1,2])('from helper %i', n => { expect(n).toBeGreaterThan(0); });\n");
    await assert.rejects(collectJest({root,runs:1}), /helper registration identity is unsupported/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects transformed TypeScript without an original source map', { skip }, async () => {
  const root = project();
  try {
    const path = join(root, 'transform.cjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace('inlineSourceMap: true', 'inlineSourceMap: false'));
    await assert.rejects(collectJest({root,runs:1}), /source mapping failed/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects a successful process with missing hook records', { skip }, async () => {
  const root = project();
  try {
    const env = join(root, 'uninstrumented.cjs');
    writeFileSync(env, "module.exports = require('jest-environment-node').TestEnvironment;\n");
    const out = join(root, '.scratch', 'missing-hook');
    mkdirSync(out, { recursive:true });
    await assert.rejects(executeJest({ root, jest:resolveJest(root), out, settings:{sources:[],selected:null},
      files:[join(root, 'tests/math.test.cjs')], environment:new URL(`file://${env}`) }), /hook data missing/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest marks a test that starts another Node interpreter', { skip }, async () => {
  const root = project();
  try {
    const file = join(root, 'tests/math.test.cjs');
    writeFileSync(file, readFileSync(file, 'utf8') +
      "test('spawns Node', () => { const { spawnSync } = require('node:child_process'); expect(spawnSync(process.execPath, ['-e','process.exit(0)']).status).toBe(0); });\n");
    const input = await collectJest({root,runs:1});
    assert.equal(input.tests.find(row => row.name === 'spawns Node').spawnsInterpreter, true);
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects runner options it cannot apply', { skip }, async () => {
  await assert.rejects(collectJest({root:fixture, runs:1, config:{runners:{jest:{tests:'tests/*.test.cjs'}}}}),
    /runners\.jest\.tests is not supported/);
});

test('Jest reports a skipped-then-passed row as passed across collection runs', { skip }, async () => {
  const root = project();
  try {
    const file = join(root, 'tests/math.test.cjs');
    writeFileSync(file, readFileSync(file, 'utf8') + `
const fsForStatus = require('node:fs');
const statusPath = __dirname + '/../.scratch/status-count.txt';
const statusCount = fsForStatus.existsSync(statusPath) ? Number(fsForStatus.readFileSync(statusPath, 'utf8')) : 0;
fsForStatus.writeFileSync(statusPath, String(statusCount + 1));
if (statusCount === 0) {
  test.skip('status changes', () => { expect(step(2)).toBe(3); });
} else {
  test('status changes', () => { expect(step(2)).toBe(3); });
}
`);
    const input = await collectJest({root,runs:2});
    const row = input.tests.find(test => test.id === 'tests/math.test.cjs::status changes');
    assert.equal(row.status, 'passed');
    assert.deepEqual(row.runStatuses, ['skipped', 'passed']);
    assert.equal(input.coverage.granularity, 'test');
  } finally { rmSync(root, { recursive:true, force:true }); }
});

test('Jest rejects a worker-thread test before execution', { skip }, async () => {
  const root = project();
  try {
    const file = join(root, 'tests/math.test.cjs');
    writeFileSync(file, readFileSync(file, 'utf8') + "test('worker', () => require('node:worker_threads'));\n");
    await assert.rejects(collectJest({root,runs:1}), /worker-thread test is unsupported/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
