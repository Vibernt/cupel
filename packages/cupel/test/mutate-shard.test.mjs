// D22: fault-test slices for CI. Plan, run slices, merge: the merge equals one whole run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignSlices, DEFAULT_RULE, mergeMutations, planDigest, suggestShards } from '../src/cli/shard.mjs';
import { makeProject } from './mutate-helpers.mjs';

test('the rule: one machine while the estimate fits the target; otherwise enough slices, capped', () => {
  assert.equal(suggestShards(7 * 60_000, 1), 1, 'a 7-minute run fits 10 minutes');
  assert.equal(suggestShards(40 * 60_000, 4), 1, '40 minutes on 4 processes at once is 10 minutes');
  assert.equal(suggestShards(40 * 60_000, 1), 5, '40 minutes in slices of 9 useful minutes');
  assert.equal(suggestShards(90 * 60_000, 1), 10);
  assert.equal(suggestShards(100 * 60 * 60_000, 1), DEFAULT_RULE.maxShards);
  assert.equal(suggestShards(90 * 60_000, 1, { startupSeconds: 120, targetMinutes: 30, maxShards: 3 }), 4 > 3 ? 3 : 4);
});

test('slices are balanced by estimate, deterministic, and free rows go to slice 1', () => {
  const entries = [['a', 90], ['b', 60], ['c', 30], ['d', 30], ['e', 30]].map(([id, ms]) => ({ id, kind: 'run', estimateMs: ms }))
    .concat([{ id: 'r', kind: 'reused', estimateMs: 0 }, { id: 'n', kind: 'no-coverage', estimateMs: 0 }]);
  const one = assignSlices(entries, 2);
  assert.deepEqual(assignSlices([...entries].reverse(), 2), one);
  const load = [0, 0];
  for (const e of entries) load[one.get(e.id) - 1] += e.estimateMs;
  assert.deepEqual(load.sort(), [120, 120]);
  assert.equal(one.get('r'), 1);
  assert.notEqual(planDigest('node', entries, 2), planDigest('node', entries, 3));
  const variants = assignSlices([...entries, { id: 'b2', kind: 'run', estimateMs: 500, after: 'b' }], 2);
  assert.equal(variants.get('b2'), variants.get('b'), 'a second variant stays with its first');
});

test('merge refuses missing, doubled, foreign and mixed slices', () => {
  const base = { spec: 'cupel-spec/1', kind: 'input', tests: [] };
  const slice = (index, total, ids, extra = {}) => ({ name: `s${index}`, doc: { ...base, ...extra,
    mutation: { mutants: ids.map((id) => ({ id, source: 'a', line: 1, operator: 'x', status: 'killed' })), targeted: ['u'], shard: { runner: 'node', index, total, plan: 'sha256:1', assigned: ids.length } } } });
  const merged = mergeMutations(base, [slice(1, 2, ['a']), slice(2, 2, ['b'])]);
  assert.deepEqual(merged.mutants.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(merged.targeted, ['u']);
  assert.throws(() => mergeMutations(base, [slice(1, 2, ['a'])]), /slice 2\/2 of node is missing|slice 2\/2 is missing/);
  assert.throws(() => mergeMutations(base, [slice(1, 2, ['a']), slice(1, 2, ['b'])]), /appears twice/);
  assert.throws(() => mergeMutations(base, [slice(1, 2, ['a']), slice(2, 2, ['a'])]), /in two parts/);
  assert.throws(() => mergeMutations(base, [slice(1, 2, ['a']), slice(2, 2, ['b'], { tests: [{ id: 'x' }] })]), /different collected input/);
});

test('plan, two slices and merge give exactly the whole run', async (t) => {
  const p = makeProject({ 'cupel.json': JSON.stringify({ tiers: { critical: ['src/calc.mjs'] }, mutation: { maxMutants: 200 } }) });
  t.after(p.cleanup);
  const env = { ...process.env, NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) assert.equal(spawnSync('git', args, { cwd: p.root, env }).status, 0);
  const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
  const cli = (...args) => { const r = spawnSync(process.execPath, [bin, ...args], { cwd: p.root, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; };
  cli('report', '--runs', '1', '--no-mutation', '--out', '.cupel/collected.json', '--json');
  const plan = JSON.parse(cli('mutate', '--input', '.cupel/collected.json', '--plan', '--json').stdout);
  assert.equal(plan.kind, 'cupel-mutation-plan');
  const node = plan.runners.find((r) => r.runner === 'node');
  assert.ok(node.faults.run > 1 && node.estimateSeconds >= 0 && node.suggestedShards === 1);
  assert.match(cli('mutate', '--input', '.cupel/collected.json', '--plan').stdout, /suggested: 1 slice/);
  const bad = spawnSync(process.execPath, [bin, 'mutate', '--input', '.cupel/collected.json', '--plan', '--max-shards', '2.5'], { cwd: p.root, env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const wrong = spawnSync(process.execPath, [bin, 'mutate', '--input', '.cupel/collected.json', '--runner', 'cargo', '--out', '.cupel/x.json'], { cwd: p.root, env, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /no runner named cargo/);
  cli('mutate', '--input', '.cupel/collected.json', '--out', '.cupel/whole.json', '--no-reuse');
  cli('mutate', '--input', '.cupel/collected.json', '--shard', '1/2', '--out', '.cupel/s1.json', '--no-reuse');
  cli('mutate', '--input', '.cupel/collected.json', '--shard', '2/2', '--out', '.cupel/s2.json', '--no-reuse');
  const s1 = JSON.parse(readFileSync(join(p.root, '.cupel/s1.json'), 'utf8')).mutation;
  const s2 = JSON.parse(readFileSync(join(p.root, '.cupel/s2.json'), 'utf8')).mutation;
  assert.ok(s1.mutants.length > 0 && s2.mutants.length > 0, 'both slices have work');
  assert.equal(s1.shard.plan, s2.shard.plan);
  cli('merge-mutations', '--input', '.cupel/collected.json', '--out', '.cupel/merged.json', '.cupel/s1.json', '.cupel/s2.json');
  const comparable = (file) => JSON.parse(readFileSync(join(p.root, file), 'utf8')).mutation.mutants.map(({ id, status, killedBy }) => ({ id, status, killedBy })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.deepEqual(comparable('.cupel/merged.json'), comparable('.cupel/whole.json'));
  const whole = JSON.parse(readFileSync(join(p.root, '.cupel/whole.json'), 'utf8')).mutation;
  assert.ok(whole.mutants.filter((m) => m.status !== 'no-coverage').every((m) => Number.isInteger(m.durationMs)), 'each run fault records its time');
});

test('merged slices keep exactly the whole run\'s targeted units, with and without a cap', async (t) => {
  const { mutateNode } = await import('../src/mutate/index.mjs');
  const { ID } = await import('./mutate-helpers.mjs');
  const p = makeProject();
  t.after(p.cleanup);
  for (const maxMutants of [2, 50]) {
    const config = { mutation: { maxMutants, seed: 5 } };
    const scope = { changed: { 'src/calc.mjs': '2-3' }, targeted: [ID.small] };
    const whole = await mutateNode({ root: p.root, config, input: p.input, scope });
    const { plan } = await mutateNode({ root: p.root, config, input: p.input, scope: { ...scope, plan: true } });
    const slices = assignSlices(plan, 2);
    const parts = [];
    for (const index of [1, 2]) {
      const only = plan.filter((e) => slices.get(e.id) === index).map((e) => e.id);
      const m = await mutateNode({ root: p.root, config, input: p.input, scope: { ...scope, only } });
      parts.push({ name: `s${index}`, doc: { kind: 'input', mutation: { ...m, shard: { runner: 'node', index, total: 2, plan: 'sha256:1', assigned: only.length } } } });
    }
    const merged = mergeMutations({ kind: 'input' }, parts);
    assert.deepEqual(merged.targeted, whole.targeted, `maxMutants ${maxMutants}`);
    assert.deepEqual(merged.mutants.map((m) => [m.id, m.status]).sort(), whole.mutants.map((m) => [m.id, m.status]).sort());
  }
});

test('first catch: the same statuses as a full run, at most one catching file per fault, and the engine refuses it outside guard\'s head', async (t) => {
  const { mutateNode } = await import('../src/mutate/index.mjs');
  const { run } = await import('../src/engine/index.mjs');
  const { loadSchemas } = await import('../src/cli/context.mjs');
  const p = makeProject();
  t.after(p.cleanup);
  const scope = { changed: { 'src/calc.mjs': '' } };
  const full = await mutateNode({ root: p.root, config: {}, input: p.input, scope });
  const first = await mutateNode({ root: p.root, config: {}, input: p.input, scope: { ...scope, firstCatch: true } });
  assert.deepEqual(first.mutants.map((m) => [m.id, m.status]), full.mutants.map((m) => [m.id, m.status]));
  const fileOf = (id) => id.split('::')[0];
  assert.ok(first.mutants.every((m) => new Set((m.killedBy ?? []).map(fileOf)).size <= 1));
  const schemas = loadSchemas();
  const marked = { ...p.input, mutation: { ...first, catches: 'first' } };
  const r = run('report', { input: marked }, {}, {}, schemas);
  assert.equal(r.exit, 2);
  assert.equal(r.report.diagnostics[0].code, 'partial-catches');
});

test('guard stops its head at the first catch by default; firstCatch: false records catches as report does', async (t) => {
  const p = makeProject({ 'cupel.json': JSON.stringify({ tiers: { critical: ['src/calc.mjs'] } }) });
  t.after(p.cleanup);
  const env = { ...process.env, NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) assert.equal(spawnSync('git', args, { cwd: p.root, env }).status, 0);
  const bin = new URL('../bin/cupel.mjs', import.meta.url).pathname;
  const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: p.root, env, encoding: 'utf8' });
  const g = cli('guard', '--base', 'HEAD', '--runs', '1', '--out', '.cupel/head.json', '--json');
  assert.equal(g.status, 0, g.stderr);
  const head = JSON.parse(readFileSync(join(p.root, '.cupel/head.json'), 'utf8'));
  assert.equal(head.mutation.catches, 'first');
  const refused = cli('report', '--input', '.cupel/head.json', '--json');
  assert.equal(refused.status, 2);
  assert.match(refused.stdout + refused.stderr, /partial-catches/);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(p.root, 'cupel.json'), JSON.stringify({ tiers: { critical: ['src/calc.mjs'] }, guard: { firstCatch: false } }));
  const g2 = cli('guard', '--base', 'HEAD', '--runs', '1', '--out', '.cupel/head2.json', '--json');
  assert.equal(g2.status, 0, g2.stderr);
  assert.equal(JSON.parse(readFileSync(join(p.root, '.cupel/head2.json'), 'utf8')).mutation.catches, undefined);
});
