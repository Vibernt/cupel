// K15: reuse of earlier fault results. A row is copied only when nothing its tests read has changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReuseBasis, reusableRows, stampBasis } from '../src/mutate/reuse.mjs';
import * as mutator from '../src/mutate/index.mjs';
import { mutate } from '../src/cli/collect.mjs';
import { effectiveConfig } from '../src/engine/config.mjs';
import { makeProject } from './mutate-helpers.mjs';

const CONFIG_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'));
const row = { id: 'src/calc.mjs:2:9:cmp:abc', source: 'src/calc.mjs', line: 2, operator: 'cmp', status: 'killed' };
const basisNow = (p, cfg = {}) => new ReuseBasis({ root: p.root, input: p.input, cfg, env: {} }).of(row);
const strip = (m) => m.mutants.map(({ basis: _b, reused: _r, ...rest }) => rest);

test('the basis changes with what the tests read, and not with what they never run', (t) => {
  const p = makeProject({ 'README.md': 'one\n', 'tests/helper.mjs': 'export const x = 1;\n' });
  t.after(p.cleanup);
  const first = basisNow(p);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(basisNow(p), first, 'stable');

  // A source no test of tests/calc.test.mjs covers, and another test file: not read by this row's run.
  writeFileSync(join(p.root, 'src/guard.mjs'), `${readFileSync(join(p.root, 'src/guard.mjs'), 'utf8')}// edit\n`);
  writeFileSync(join(p.root, 'tests/guard.test.mjs'), `${readFileSync(join(p.root, 'tests/guard.test.mjs'), 'utf8')}// edit\n`);
  assert.equal(basisNow(p), first);

  // The mutated source, the test file that runs it, any other project file: all can change the outcome.
  for (const [path, text] of [['src/calc.mjs', 'export const changed = 1;\n'], ['tests/calc.test.mjs', '// edit\n'], ['tests/helper.mjs', 'export const x = 2;\n'], ['package.json', '{}\n']]) {
    const before = basisNow(p);
    writeFileSync(join(p.root, path), text);
    assert.notEqual(basisNow(p), before, path);
  }

  // Files config names as never read by tests are left out; the list itself is part of the basis.
  const cfg = { mutation: { reuse: { ignore: ['**/*.md'] } } };
  const ignored = basisNow(p, cfg);
  writeFileSync(join(p.root, 'README.md'), 'two\n');
  assert.equal(basisNow(p, cfg), ignored);
  assert.notEqual(basisNow(p, cfg), basisNow(p));
});

test('the basis changes when another passed test starts to run the line, or the runtime changes', (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const first = basisNow(p);
  p.input.coverage.byTest['tests/guard.test.mjs::guard lets good input through']['src/calc.mjs'] = '2';
  assert.notEqual(basisNow(p), first);
  const q = makeProject();
  t.after(q.cleanup);
  const before = basisNow(q);
  q.input.runtime = { name: 'node', version: '0.0.1' };
  assert.notEqual(basisNow(q), before);
});

test('only killed, survived and no-coverage rows with an unchanged basis are reusable', (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const basis = new ReuseBasis({ root: p.root, input: p.input, cfg: {}, env: {} });
  const good = basis.of(row);
  const rows = ['killed', 'survived', 'no-coverage', 'timeout', 'error'].map((status, k) => ({ ...row, id: `${row.id}${k}`, status }));
  const previous = { kind: 'input', mutation: { mutants: [
    ...rows.map((r) => ({ ...r, basis: basis.of(r) })),
    { ...row, id: 'stale', basis: `sha256:${'0'.repeat(64)}` },
    { ...row, id: 'unstamped' },
  ] } };
  const reuse = reusableRows({ previous, basis });
  assert.deepEqual(Object.keys(reuse).sort(), [`${row.id}0`, `${row.id}1`, `${row.id}2`]);
  for (const r of Object.values(reuse)) assert.equal(r.reused, true);
  assert.match(good, /^sha256:/);
});

test('mutateNode copies reused rows without running them, keeping the sample and the cap', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const scope = { changed: { 'src/calc.mjs': '2-3' } };
  const config = { mutation: { maxMutants: 4, seed: 3 } };
  const fresh = await mutator.mutateNode({ root: p.root, config, input: p.input, scope });
  const basis = new ReuseBasis({ root: p.root, input: p.input, cfg: config, env: {} });
  const stamped = stampBasis(fresh, basis);
  const reuse = reusableRows({ previous: { kind: 'input', mutation: stamped }, basis });
  assert.equal(Object.keys(reuse).length, fresh.mutants.length);
  const metrics = {};
  const again = await mutator.mutateNode({ root: p.root, config, input: p.input, scope: { ...scope, reuse }, metrics });
  assert.equal(metrics.textBuilds, 0, 'nothing was built or run');
  assert.deepEqual(strip(again), strip(fresh));
  assert.equal(again.sampled, fresh.sampled);
  assert.ok(again.mutants.every((m) => m.reused === true));
});

test('the CLI mutate step stamps every row and reuses an earlier input; a changed source runs again', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const cfg = effectiveConfig({ mutation: { maxMutants: 20 } }, CONFIG_SCHEMA);
  const scope = { changed: { 'src/calc.mjs': '2-3' } };
  const logs = [];
  const log = (m) => logs.push(m);
  const first = await mutate(mutator, { root: p.root, cfg, input: p.input, scope, log, previous: null });
  assert.ok(first.mutants.length > 0);
  assert.ok(first.mutants.every((m) => /^sha256:/.test(m.basis) && m.reused === undefined));
  const second = await mutate(mutator, { root: p.root, cfg, input: p.input, scope, log, previous: { kind: 'input', mutation: first } });
  assert.deepEqual(strip(second), strip(first));
  assert.ok(second.mutants.every((m) => m.reused === true));
  assert.deepEqual(second.mutants.map((m) => m.basis), first.mutants.map((m) => m.basis));
  assert.ok(logs.some((m) => /reuse: \d+ of \d+ earlier fault results still hold/.test(m)));

  writeFileSync(join(p.root, 'tests/calc.test.mjs'), `${readFileSync(join(p.root, 'tests/calc.test.mjs'), 'utf8')}// changed\n`);
  const third = await mutate(mutator, { root: p.root, cfg, input: p.input, scope, log, previous: { kind: 'input', mutation: second } });
  assert.ok(third.mutants.every((m) => m.reused === undefined), 'the test file that runs these lines changed');
  assert.deepEqual(strip(third), strip(first));

  const off = effectiveConfig({ mutation: { maxMutants: 20, reuse: false } }, CONFIG_SCHEMA);
  const fourth = await mutate(mutator, { root: p.root, cfg: off, input: p.input, scope, log, previous: { kind: 'input', mutation: third } });
  assert.ok(fourth.mutants.every((m) => m.reused === undefined && m.basis === undefined));
});

test('previousInput: off, a missing file is a cache miss, an invalid file is refused, the default is .cupel/input.json', async (t) => {
  const { previousInput } = await import('../src/mutate/reuse.mjs');
  const { mkdirSync } = await import('node:fs');
  const p = makeProject();
  t.after(p.cleanup);
  const logs = [];
  assert.equal(previousInput({ off: true, root: p.root }), null);
  assert.equal(previousInput({ file: join(p.root, 'absent.json'), root: p.root, log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /absent\.json not found; every fault runs/);
  writeFileSync(join(p.root, 'bad.json'), '{"kind":"report"}');
  assert.throws(() => previousInput({ file: join(p.root, 'bad.json'), root: p.root }), /not a Cupel input with mutation results/);
  assert.equal(previousInput({ root: p.root }), null, 'no default file');
  mkdirSync(join(p.root, '.cupel'));
  const saved = { kind: 'input', mutation: { mutants: [] } };
  writeFileSync(join(p.root, '.cupel/input.json'), JSON.stringify(saved));
  assert.deepEqual(previousInput({ root: p.root }), saved);
});

test('the CLI refuses --reuse with --no-reuse, and guard --changed with --base', async () => {
  const { spawnSync } = await import('node:child_process');
  const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const both = run(['report', '--reuse', 'x.json', '--no-reuse']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /either --reuse or --no-reuse/);
  const guard = run(['guard', '--base', 'HEAD', '--changed', 'HEAD']);
  assert.equal(guard.status, 2);
  assert.match(guard.stderr, /--changed is for a saved base/);
});

test('report reuses its own earlier .cupel/input.json in a git project; Cupel files never count as project files', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const p = makeProject({ 'cupel.json': JSON.stringify({ tiers: { critical: ['src/calc.mjs'] }, mutation: { maxMutants: 200 } }) });
  t.after(p.cleanup);
  const env = { ...process.env, NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) assert.equal(spawnSync('git', args, { cwd: p.root, env }).status, 0);
  const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
  const report = () => spawnSync(process.execPath, [bin, 'report', '--runs', '1', '--json'], { cwd: p.root, env, encoding: 'utf8' });
  const first = report();
  assert.equal(first.status, 0, first.stderr);
  const saved = JSON.parse(readFileSync(join(p.root, '.cupel/input.json'), 'utf8')).mutation.mutants;
  const settled = saved.filter((m) => ['killed', 'survived', 'no-coverage'].includes(m.status)).length;
  assert.ok(settled > 0);
  const second = report();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, new RegExp(`reuse: ${settled} of ${saved.length} earlier fault results still hold`));
  const again = JSON.parse(readFileSync(join(p.root, '.cupel/input.json'), 'utf8')).mutation.mutants;
  assert.equal(again.filter((m) => m.reused).length, settled);
});

test('compiled languages and tests that start programs make every source part of the basis', (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const rust = { ...row, id: 'src/calc.rs:2:1:op:x', source: 'src/calc.rs' };
  p.input.sources['src/calc.rs'] = { coverable: '1-4' };
  p.input.coverage.byTest['tests/calc.test.mjs::clamp caps big values']['src/calc.rs'] = '2';
  writeFileSync(join(p.root, 'src/calc.rs'), 'fn a() {}\n');
  const of = (r) => new ReuseBasis({ root: p.root, input: p.input, cfg: {}, env: {} }).of(r);
  const [jsBefore, rsBefore] = [of(row), of(rust)];
  writeFileSync(join(p.root, 'src/guard.mjs'), '// a source these tests never run\n');
  assert.equal(of(row), jsBefore, 'JavaScript: an unrun source is left out');
  assert.notEqual(of(rust), rsBefore, 'Rust: constants and macros cross files, so every source counts');
  const before = of(row);
  p.input.tests.find((x) => x.file === 'tests/calc.test.mjs').spawnsInterpreter = true;
  const spawning = of(row);
  writeFileSync(join(p.root, 'src/guard.mjs'), '// changed again\n');
  assert.notEqual(of(row), spawning, 'a test that starts another interpreter may run any source');
  assert.notEqual(spawning, before);
});

test('a row caught by a test outside its run (a cross-runner catch) is never reused', (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const basis = new ReuseBasis({ root: p.root, input: p.input, cfg: {}, env: {} });
  const own = { ...row, killedBy: ['tests/calc.test.mjs::clamp caps big values'] };
  const cross = { ...row, id: `${row.id}x`, killedBy: ['tests/guard.test.mjs::guard lets good input through'] };
  const previous = { kind: 'input', mutation: { mutants: [own, cross].map((r) => ({ ...r, basis: basis.of(r) })) } };
  assert.deepEqual(Object.keys(reusableRows({ previous, basis })), [own.id]);
});

test('in git, ignored files and installed-dependency records count; dependency folders and Cupel files do not', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const p = makeProject({ '.gitignore': '.env\nnode_modules/\ndist/\n', '.env': 'A=1\n', 'dist/out.js': '1\n',
    'node_modules/.package-lock.json': '{"v":1}\n', 'node_modules/dep/index.js': '1\n' });
  t.after(p.cleanup);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: p.root }).status, 0);
  const now = () => basisNow(p);
  const steps = [['.env', 'A=2\n', true], ['dist/out.js', '2\n', true], ['node_modules/.package-lock.json', '{"v":2}\n', true],
    ['node_modules/dep/index.js', '2\n', false], ['.cupel/input.json', '{}\n', false]];
  for (const [path, text, counts] of steps) {
    const before = now();
    mkdirSync(join(p.root, path, '..'), { recursive: true });
    writeFileSync(join(p.root, path), text);
    (counts ? assert.notEqual : assert.equal)(now(), before, path);
  }
});

test('a mutant a targeted unit covers is run, not reused: the earlier row may have stopped early', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  const scope = { changed: { 'src/calc.mjs': '2-3' } };
  const fresh = await mutator.mutateNode({ root: p.root, config: {}, input: p.input, scope });
  const basis = new ReuseBasis({ root: p.root, input: p.input, cfg: {}, env: {} });
  const reuse = reusableRows({ previous: { kind: 'input', mutation: stampBasis(fresh, basis) }, basis });
  const targeted = await mutator.mutateNode({ root: p.root, config: {}, input: p.input,
    scope: { targeted: ['tests/calc.test.mjs::clamp touches small values'], reuse } });
  assert.ok(targeted.mutants.length > 0);
  assert.ok(targeted.mutants.every((m) => m.reused === undefined));
});

test('guard, check and mutate reuse only a file named with --reuse, never the in-tree default', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const p = makeProject({ 'cupel.json': JSON.stringify({ tiers: { critical: ['src/calc.mjs'] } }) });
  t.after(p.cleanup);
  const env = { ...process.env, NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) assert.equal(spawnSync('git', args, { cwd: p.root, env }).status, 0);
  const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: p.root, env, encoding: 'utf8' });
  assert.equal(cli('report', '--runs', '1', '--json').status, 0);
  const { mutation: _m, ...collected } = JSON.parse(readFileSync(join(p.root, '.cupel/input.json'), 'utf8'));
  writeFileSync(join(p.root, '.cupel/collected.json'), JSON.stringify(collected));
  const plain = cli('mutate', '--input', '.cupel/collected.json', '--out', '.cupel/out.json');
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stderr, /reuse:/);
  const named = cli('mutate', '--input', '.cupel/collected.json', '--out', '.cupel/out.json', '--reuse', '.cupel/input.json');
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stderr, /reuse: [1-9]\d* of \d+ earlier fault results still hold/);
});
