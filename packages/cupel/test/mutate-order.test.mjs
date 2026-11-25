import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutate } from '../src/cli/collect.mjs';
import { mutateNode, generateMutants } from '../src/mutate/index.mjs';
import { isOwnTestFile, orderTestFiles } from '../src/mutate/order.mjs';
import { makeProject } from './mutate-helpers.mjs';

test('own-file matching covers colocated, nested and mirrored test directories', () => {
  for (const file of ['src/a/b.test.ts', 'src/a/__tests__/b.spec.tsx', 'test/a/b.test.mjs', 'tests/a/b.spec.js'])
    assert.equal(isOwnTestFile('src/a/b.ts', file), true, file);
  for (const file of ['src/a/c.test.ts', 'other/a/b.test.ts', 'tests/b.test.ts', 'src/a/b.ts'])
    assert.equal(isOwnTestFile('src/a/b.ts', file), false, file);
});

test('catch history, own files and the existing input rule form one deterministic permutation', () => {
  const files = ['slow/global.test.mjs', 'src/a/b.test.ts', 'src/a/__tests__/b.spec.tsx', 'test/a/b.test.mjs', 'fast/global.test.mjs'];
  const counts = new Map(files.map((file, i) => [file, [1, 1, 2, 1, 2][i]]));
  const ms = new Map(files.map((file, i) => [file, [100, 20, 10, 5, 1][i]]));
  const args = { counts, inputMs: (file) => ms.get(file), source: 'src/a/b.ts',
    previousCatchers: ['history', 'history', 'unknown'],
    fileOfTest: (id) => id === 'history' ? 'slow/global.test.mjs' : undefined };
  const expected = ['slow/global.test.mjs', 'src/a/__tests__/b.spec.tsx', 'test/a/b.test.mjs', 'src/a/b.test.ts', 'fast/global.test.mjs'];
  assert.deepEqual(orderTestFiles(args), expected);
  assert.deepEqual(orderTestFiles(args), expected);
  assert.deepEqual([...orderTestFiles(args)].sort(), [...files].sort());
});

test('catch history changes first-catch credit, never mutant statuses', async (t) => {
  const historyId = 'tests/history.test.mjs::history catches clamp';
  const p = makeProject({ 'tests/history.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/calc.mjs';
test('history catches clamp', () => assert.equal(clamp(50), 10));
` });
  t.after(p.cleanup);
  p.input.tests.push({ id: historyId, file: 'tests/history.test.mjs', name: 'history catches clamp', status: 'passed', durationsMs: [1] });
  p.input.coverage.byTest[historyId] = { 'src/calc.mjs': '2' };
  p.input.coverage.setup['tests/history.test.mjs'] = { 'src/calc.mjs': '1' };
  const text = readFileSync(`${p.root}/src/calc.mjs`, 'utf8');
  const fault = generateMutants('src/calc.mjs', text).find((m) => m.line === 2 && m.operator === 'cmp-flip');
  const options = { root: p.root, input: p.input, config: { mutation: { maxMutants: 20, maxSeconds: 30 } }, jobs: 1 };
  const fresh = await mutateNode({ ...options, scope: { changed: { 'src/calc.mjs': '2' }, firstCatch: true } });
  const ordered = await mutateNode({ ...options, scope: { changed: { 'src/calc.mjs': '2' }, firstCatch: true,
    catchers: { [fault.id]: [historyId] } } });
  assert.deepEqual(Object.fromEntries(fresh.mutants.map((m) => [m.id, m.status])),
    Object.fromEntries(ordered.mutants.map((m) => [m.id, m.status])));
  assert.notDeepEqual(fresh.mutants.find((m) => m.id === fault.id).killedBy,
    ordered.mutants.find((m) => m.id === fault.id).killedBy);
  assert.deepEqual(ordered.mutants.find((m) => m.id === fault.id).killedBy, [historyId]);
});

test('the CLI mutation wrapper forwards previous catcher ids to the JavaScript runner', async (t) => {
  const p = makeProject();
  t.after(p.cleanup);
  let received;
  const mutator = { async mutateNode({ scope }) { received = scope; return { mutants: [], targeted: [] }; } };
  const previous = { ...p.input, mutation: { mutants: [{ id: 'fault', killedBy: ['catcher'], status: 'killed' }] } };
  await mutate(mutator, { root: p.root, cfg: { runners: { node: {} }, mutation: { reuse: false } }, input: p.input,
    previous, scope: { critical: true }, log: () => {} });
  assert.deepEqual(received.catchers, { fault: ['catcher'] });
});
