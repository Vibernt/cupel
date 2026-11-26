// K14: rows of runners that test the same source combine into one per mutant (issue 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { combineRows, combineRunnerMutations, targetedLinesForOtherRunners, addChanged } from '../src/cli/runner-mutations.mjs';
import { mergeRunners } from '../src/cli/merge-runners.mjs';
import { mergeMutations } from '../src/cli/shard.mjs';
import { confirm, mutate } from '../src/cli/collect.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(repo, '.scratch');

/** Two runners (node, vitest) over the same source, with distinct test ids. */
function shared() {
  const source = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
  const a = structuredClone(source), b = structuredClone(source);
  b.tests = b.tests.map((t) => ({ ...t, id: `web/${t.id}`, file: `web/${t.file}`, ...(t.unit ? { unit: `web/${t.unit}` } : {}) }));
  b.coverage.byTest = Object.fromEntries(Object.entries(b.coverage.byTest ?? {}).map(([id, e]) => [`web/${id}`, e]));
  b.coverage.setup = {};
  const path = Object.keys(a.sources)[0];
  const line = Number(String(Object.values(a.coverage.byTest)[0][path]).split(/[,-]/)[0]);
  return { a, b, path, line };
}

test('the status that decides credits every row with it; a total time only when every run was timed', () => {
  const base = { id: 'm', source: 's', line: 1, operator: 'op' };
  const out = combineRows([{ ...base, status: 'timeout', killedBy: ['b'], durationMs: 3 }, { ...base, status: 'survived' }, { ...base, status: 'timeout', killedBy: ['a'], durationMs: 4 }]);
  assert.equal(out.status, 'timeout');
  assert.deepEqual(out.killedBy, ['a', 'b']);
  assert.equal(out.durationMs, undefined, 'one runner did not time its run');
  const timed = combineRows([{ ...base, status: 'survived', durationMs: 2 }, { ...base, status: 'no-coverage' }, { ...base, status: 'survived', durationMs: 5 }]);
  assert.equal(timed.durationMs, 7);
  assert.equal(combineRows([{ ...base, status: 'error' }, { ...base, status: 'survived' }]).status, 'error');
  assert.equal(combineRows([{ ...base, status: 'survived', reused: true, basis: 'x' }, { ...base, status: 'survived', basis: 'y' }]).basis, undefined);
});

test('one id is one mutant: the same id at another place is refused; rows come out sorted by id', () => {
  const row = (id, extra = {}) => ({ id, source: 's', line: 1, operator: 'op', status: 'survived', ...extra });
  assert.throws(() => combineRunnerMutations([{ name: 'node', mutation: { mutants: [row('m')] } }, { name: 'vitest', mutation: { mutants: [row('m', { line: 2 })] } }]), /reports mutant m/);
  const { mutation } = combineRunnerMutations([{ name: 'node', mutation: { mutants: [row('b'), row('a')] } }, { name: 'vitest', mutation: { mutants: [row('c')] } }]);
  assert.deepEqual(mutation.mutants.map((m) => m.id), ['a', 'b', 'c']);
});

test('saved inputs: a runner without mutation results still counts, and first-catch inputs keep their mark', () => {
  const { a, b, path, line } = shared();
  a.mutation = { mutants: [{ id: 'm', source: path, line, operator: 'arith', status: 'survived' }], targeted: [] };
  const merged = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  assert.deepEqual(merged.mutation.mutants, [], 'vitest covers the line but has no answer: not a complete survivor');
  assert.equal(merged.mutation.sampled, true);

  const first = structuredClone(a); first.mutation = { mutants: [{ id: 'm', source: path, line, operator: 'arith', status: 'killed', killedBy: [a.tests[0].id] }], targeted: [], catches: 'first' };
  const other = structuredClone(b); other.mutation = { mutants: [{ id: 'm', source: path, line, operator: 'arith', status: 'survived' }], targeted: [], catches: 'first' };
  assert.equal(mergeRunners([{ name: 'node', input: first }, { name: 'vitest', input: other }]).mutation.catches, 'first');
  const full = structuredClone(other); delete full.mutation.catches;
  assert.throws(() => mergeRunners([{ name: 'node', input: first }, { name: 'vitest', input: full }]), /first-catch and full/);
});

test('a targeted unit of one runner sends its lines to the other runners that share the source', async () => {
  const { a, b, path } = shared();
  const input = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  const unit = a.tests[0].unit ?? a.tests[0].id;
  const lines = targetedLinesForOtherRunners(input, [unit], b);
  assert.ok(lines[path] && lines[path] !== '', 'non-empty lines for the shared source');
  assert.deepEqual(targetedLinesForOtherRunners(input, [unit], a), {}, 'the owning runner uses its targeted scope');
  assert.deepEqual(addChanged({ [path]: '' }, { [path]: '3' }), { [path]: '' }, 'a whole file stays whole');

  const scopes = {};
  const mutator = { async mutateNode({ input: part, scope }) {
    scopes[part.tests[0].id.startsWith('web/') ? 'vitest' : 'node'] = scope;
    return { mutants: [], targeted: [] };
  } };
  await mutate(mutator, { root: scratch, cfg: { runners: { node: {}, vitest: {} } }, input, scope: { targeted: [unit] }, log: () => {} });
  assert.deepEqual(scopes.node.targeted, [unit]);
  assert.deepEqual(scopes.vitest.targeted, []);
  assert.equal(scopes.vitest.changed[path], lines[path]);
});

test('merge-mutations combines per-runner slices that share a mutant instead of refusing it', () => {
  const { a, b, path, line } = shared();
  const base = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  const doc = (runner, row) => ({ ...structuredClone(base), mutation: { mutants: [row], targeted: [], shard: { runner, index: 1, total: 1, plan: 'p' } } });
  const merged = mergeMutations(base, [
    { name: 'node.json', doc: doc('node', { id: 'm', source: path, line, operator: 'arith', status: 'survived' }) },
    { name: 'vitest.json', doc: doc('vitest', { id: 'm', source: path, line, operator: 'arith', status: 'killed', killedBy: [b.tests[0].id] }) },
  ]);
  assert.deepEqual(merged.mutants.map((m) => [m.id, m.status, m.killedBy]), [['m', 'killed', [b.tests[0].id]]]);
});

test('confirming survivors of a merged input read from disk runs every runner that ran them, and a catch wins', async () => {
  const { a, b, path, line } = shared();
  const merged = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  const fromDisk = JSON.parse(JSON.stringify(merged)); // no in-memory runner parts
  const row = { id: 'm', source: path, line, operator: 'arith', status: 'survived', durationMs: 9, reused: true };
  const asked = [];
  const mutator = { async confirmSurvivors({ input: part, mutation, ids }) {
    const web = part.tests[0].id.startsWith('web/');
    asked.push(web ? 'vitest' : 'node');
    return { ...mutation, mutants: mutation.mutants.map((m) => (ids.includes(m.id) && web ? { ...m, status: 'killed', killedBy: [b.tests[0].id] } : m)) };
  } };
  const out = await confirm(mutator, { root: scratch, cfg: { runners: { node: {}, vitest: {} }, mutation: { reuse: false } }, input: fromDisk,
    mutation: { mutants: [row], targeted: [] }, ids: ['m'], log: () => {} });
  assert.deepEqual(asked.sort(), ['node', 'vitest']);
  assert.equal(out.mutants[0].status, 'killed');
  assert.deepEqual(out.mutants[0].killedBy, [b.tests[0].id]);
  assert.equal(out.mutants[0].durationMs, 9, 'the measured time of the run stays');
  assert.equal(out.mutants[0].reused, undefined, 'a changed answer is not a copied one');
});

test('a catch and a timeout in different runners both credit their tests; one runner may not report a mutant twice', () => {
  const base = { id: 'm', source: 's', line: 1, operator: 'op' };
  const out = combineRows([{ ...base, status: 'killed', killedBy: ['a'] }, { ...base, status: 'timeout', killedBy: ['b'] }]);
  assert.equal(out.status, 'killed');
  assert.deepEqual(out.killedBy, ['a', 'b']);
  assert.throws(() => combineRunnerMutations([{ name: 'node', mutation: { mutants: [{ ...base, status: 'survived' }, { ...base, status: 'killed' }] } }]), /reports mutant m twice/);
});

test('at file granularity a targeted unit sends its whole-file lines, less setup, to the other runners', () => {
  const { a, b, path } = shared();
  const input = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  input.coverage = { granularity: 'file', byTest: {}, byFile: { [a.tests[0].file]: { [path]: '1-6' } }, setup: { [a.tests[0].file]: { [path]: '1' } } };
  const unit = a.tests[0].unit ?? a.tests[0].id;
  assert.deepEqual(targetedLinesForOtherRunners(input, [unit], b), { [path]: '2-6' });
});

test('merge-mutations counts every runner of the input, also one whose slices are not given, and refuses unknown runners', () => {
  const { a, b, path, line } = shared();
  const base = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  const doc = (runner, row) => ({ ...structuredClone(base), mutation: { mutants: [row], targeted: [], shard: { runner, index: 1, total: 1, plan: 'p' } } });
  const nodeOnly = mergeMutations(base, [{ name: 'node.json', doc: doc('node', { id: 'm', source: path, line, operator: 'arith', status: 'survived' }) }]);
  assert.deepEqual(nodeOnly.mutants, [], 'Vitest covers the line but its slices are absent');
  assert.equal(nodeOnly.sampled, true);
  assert.throws(() => mergeMutations(base, [{ name: 'x.json', doc: doc('jest', { id: 'm', source: path, line, operator: 'arith', status: 'survived' }) }]), /runner jest: not in the collected input/);
});
