import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeInputs } from '../src/cli/merge-inputs.mjs';
import { mergeRunners } from '../src/cli/merge-runners.mjs';
import { nodeFlags } from '../src/cli/node-flags.mjs';

const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const run = (root, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'cupel-once-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'tests/a.test.mjs'), "import { test } from 'node:test'; import { value } from '../src/value.mjs'; test('a', () => { if (value !== 1) throw Error('bad'); });\n");
  writeFileSync(join(root, 'tests/b.test.mjs'), "import { test } from 'node:test'; import { value } from '../src/value.mjs'; test('b', () => { if (value !== 1) throw Error('bad'); });\n");
  return root;
}

test('collect-node writes one-run input and JUnit from its ordinary run', (t) => {
  const root = project(t), out = join(root, 'input.json'), junit = join(root, 'results.xml');
  const r = run(root, 'collect-node', '--out', out, '--junit', junit, '--quiet', '--', '--test-concurrency=2');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(out).collection.runs, 1);
  assert.match(read(out).collection.config, /^sha256:[0-9a-f]{64}$/);
  assert.equal(read(out).collection.commit, undefined);
  assert.equal(read(out).tests.length, 2);
  assert.match(readFileSync(junit, 'utf8'), /<testcase/);
  assert.match(readFileSync(junit, 'utf8'), /name="a"/);
  const visible = run(root, 'collect-node', '--out', out, '--junit', junit, '--runs', '2');
  assert.equal(visible.status, 0, visible.stderr);
  assert.match(visible.stdout, /a/);
  assert.match(visible.stderr.trim().split('\n').at(-1), /^cupel: tests passed \(2 passed, 0 failed, 0 skipped\); input written to /);
  assert.equal(read(out).collection.runs, 2);
  assert.equal((readFileSync(junit, 'utf8').match(/<testcase /g) ?? []).length, 2);
});

test('failing test writes input and exits 1; killed worker removes stale input and exits 3', (t) => {
  const root = project(t), out = join(root, 'input.json'), skipped = join(root, 'skipped.json');
  writeFileSync(join(root, 'tests/b.test.mjs'), "import { test } from 'node:test'; test('b', () => { throw Error('failure'); });\n");
  let r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 1, r.stderr);
  assert.equal(read(out).tests.find((x) => x.name === 'b').status, 'failed');
  assert.ok(existsSync(skipped));
  writeFileSync(join(root, 'tests/b.test.mjs'), "process.kill(process.pid, 'SIGKILL');\n");
  r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 3, r.stderr);
  assert.ok(!existsSync(out));
  assert.ok(!existsSync(skipped));
});

test('node pass-through refuses filtering, arbitrary flags, positional files and mismatched reporters', (t) => {
  const root = project(t);
  for (const args of [['--test-name-pattern=a'], ['--test-shard=1/2'], ['--inspect'], ['--experimental-test-coverage'],
    ['--watch'], ['--bad-flag'], ['tests/a.test.mjs'], ['--test-reporter=spec']]) {
    const r = run(root, 'collect-node', '--quiet', '--', ...args);
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(args[0].startsWith('--test-reporter') ? 'equal numbers' : args[0].split('=')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('shards partition by sorted files; merged evidence matches unsharded collection', (t) => {
  const root = project(t);
  const full = join(root, 'full.json'), a = join(root, 'a.json'), b = join(root, 'b.json'), merged = join(root, 'merged.json');
  for (const [out, shard] of [[full, null], [a, '1/2'], [b, '2/2']]) {
    const r = run(root, 'collect-node', '--out', out, '--quiet', ...(shard ? ['--shard', shard] : []));
    assert.equal(r.status, 0, r.stderr);
  }
  const r = run(root, 'merge-inputs', a, b, '--out', merged, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  const [whole, result] = [read(full), read(merged)];
  assert.deepEqual(result.tests.map(({ id, file, status, runStatuses }) => ({ id, file, status, runStatuses })),
    whole.tests.map(({ id, file, status, runStatuses }) => ({ id, file, status, runStatuses })));
  for (const field of ['byTest', 'setup']) assert.deepEqual(result.coverage[field], whole.coverage[field]);
  assert.deepEqual(result.sources, whole.sources);
  assert.deepEqual(Object.keys(read(a).collection.shard.files), ['tests/a.test.mjs']);
  assert.deepEqual(Object.keys(read(b).collection.shard.files), ['tests/b.test.mjs']);
  assert.ok(!result.collection.shard);
});

test('subset collection records hashes and rejects files outside suite or with sharding', (t) => {
  const root = project(t), out = join(root, 'subset.json');
  let r = run(root, 'collect-node', '--tests', 'tests/a.test.mjs', '--tests', 'tests/a.test.mjs', '--out', out, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(out).collection.subset.files, { 'tests/a.test.mjs': digest(readFileSync(join(root, 'tests/a.test.mjs'))) });
  assert.equal(read(out).tests.length, 1);
  r = run(root, 'collect-node', '--tests', 'src/value.mjs', '--quiet');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not in configured suite/);
  r = run(root, 'collect-node', '--tests', 'tests/a.test.mjs', '--shard', '1\/2', '--quiet');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

test('empty shards are valid and malformed shard values exit 2', (t) => {
  const root = project(t), out = join(root, 'empty.json');
  let r = run(root, 'collect-node', '--shard', '3/3', '--out', out, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(out).tests, []);
  assert.deepEqual(read(out).collection.shard.files, {});
  for (const shard of ['0/2', '2/1', 'x/3', '1/0', '1/2/3']) {
    r = run(root, 'collect-node', '--shard', shard, '--quiet');
    assert.equal(r.status, 2, shard);
  }
});

test('a selected file with zero tests contributes a summary and no synthetic test row', (t) => {
  const root = project(t), out = join(root, 'input.json');
  writeFileSync(join(root, 'tests/empty.test.mjs'), '\n');
  const r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(out).tests.length, 2);
  assert.deepEqual(read(out).coverage.setup['tests/empty.test.mjs'], {});
});

test('collect-node refuses a truncated hook instead of writing partial evidence', (t) => {
  const root = project(t), out = join(root, 'input.json');
  writeFileSync(join(root, 'tests/a.test.mjs'), `import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.env.CUPEL_NODE_HOOK, 'utf8'));
process.on('exit', () => writeFileSync(cfg.out + '/' + process.pid + '.json', '{'));
test('a', () => {});
`);
  const r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /incomplete node coverage/);
  assert.ok(!existsSync(out));
});

const paths = ['tests/a.test.mjs', 'tests/b.test.mjs'];
const hashes = Object.fromEntries(paths.map((path, i) => [path, digest(`file ${i}`)]));
const suite = digest(JSON.stringify(Object.entries(hashes)));
function part(index) {
  const file = paths[index - 1], id = `test-${index}`;
  return { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '22.23.3' },
    sources: { 'src/a.mjs': { coverable: '1-2', hash: 'source' } },
    tests: [{ id, file, name: id, status: 'passed' }],
    coverage: { granularity: 'test', byTest: { [id]: { 'src/a.mjs': String(index) } }, setup: { [file]: {} }, unstable: {} },
    collection: { runs: 1, config: digest('config'), shard: { index, total: 2, suite, files: { [file]: hashes[file] } } },
    brittleness: [], shapes: {} };
}
const pieces = () => [{ file: 'a.json', input: part(1) }, { file: 'b.json', input: part(2) }];

for (const [field, change] of [
    ['spec', (x) => { x.spec = 'cupel-spec/1.1'; }],
    ['runtime', (x) => { x.runtime.version = '26.7.0'; }],
    ['runtimes', (x) => { x.runtimes = [{ runner: 'node', name: 'node', version: '22.23.3' }]; }],
    ['coverage.granularity', (x) => { x.coverage.granularity = 'file'; }],
    ['collection.runs', (x) => { x.collection.runs = 2; }],
    ['collection.config', (x) => { delete x.collection.config; }],
    ['collection.commit', (x) => { x.collection.commit = 'a'.repeat(40); }],
    ['shard.total', (x) => { x.collection.shard.total = 3; }],
    ['shard.suite', (x) => { x.collection.shard.suite = digest('other'); }],
    ['sources', (x) => { x.sources['src/a.mjs'].hash = 'other'; }],
  ]) test(`merge-inputs refuses mismatched ${field}`, () => {
    const inputs = pieces(); change(inputs[1].input);
    assert.throws(() => mergeInputs(inputs), (e) => e.exit === 3 && e.message.includes(field) && e.message.includes('a.json') && e.message.includes('b.json'), field);
  });

for (const [message, change] of [
    ['missing shard index 2', (p) => p.pop()],
    ['duplicate shard index 1', (p) => { p[1].input.collection.shard.index = 1; }],
    ['shard file', (p) => { p[1].input.collection.shard.files = { [paths[0]]: hashes[0] }; }],
    ['shard.suite', (p) => { p[1].input.collection.shard.files[paths[1]] = digest('changed'); }],
    ['outside shard.files', (p) => { p[1].input.tests[0].file = 'tests/other.test.mjs'; }],
    ['duplicate test id', (p) => { p[1].input.tests[0].id = p[0].input.tests[0].id; }],
    ['coverage.setup key', (p) => { p[1].input.coverage.setup = { [paths[0]]: {} }; }],
  ]) test(`merge-inputs refuses ${message}`, () => {
    const inputs = pieces(); change(inputs);
    assert.throws(() => mergeInputs(inputs), (e) => e.exit === 3 && e.message.includes(message), message);
  });

for (const [message, change] of [
    ['merge shards before mutation', (x) => { x.mutation = { mutants: [] }; }],
    ['subset', (x) => { x.collection.subset = { files: {} }; }],
    ['not a collection shard', (x) => { delete x.collection.shard; }],
  ]) test(`merge-inputs refuses ${message}`, () => {
    const inputs = pieces(); change(inputs[1].input);
    assert.throws(() => mergeInputs(inputs), (e) => e.exit === 2 && e.message.includes(message));
  });

test('merge-inputs CLI validates each named file before merging', (t) => {
  const root = project(t), bad = join(root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ spec: 'cupel-spec/2' }));
  const r = run(root, 'merge-inputs', bad, '--out', join(root, 'merged.json'), '--quiet');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad\.json/);
  assert.ok(!existsSync(join(root, 'merged.json')));
});

test('multi-runner merge retains only agreeing run count', () => {
  const a = part(1), b = part(2);
  const same = mergeRunners([{ name: 'a', input: a }, { name: 'b', input: b }]);
  assert.deepEqual(same.collection, { runs: 1 });
  b.collection.runs = 2;
  const different = mergeRunners([{ name: 'a', input: a }, { name: 'b', input: b }]);
  assert.equal(different.collection, undefined);
});

test('mutate accepts precollected input and refuses stale source, shard and existing mutation', (t) => {
  const root = project(t), out = join(root, 'input.json'), mutated = join(root, 'mutated.json');
  const r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  const stub = join(root, 'mutator.mjs');
  writeFileSync(stub, 'export async function mutateNode() { return { mutants: [], targeted: [] }; }\n');
  const env = { ...process.env, NODE_ENV: 'test', CUPEL_TEST_MUTATOR: stub };
  const invoke = (input = out) => spawnSync(process.execPath, [BIN, 'mutate', '--input', input, '--out', mutated, '--quiet'], { cwd: root, env, encoding: 'utf8' });
  let result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(read(mutated).mutation, { mutants: [], targeted: [] });
  result = invoke(mutated);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /already has mutation/);
  const shard = join(root, 'shard.json');
  const input = read(out);
  input.collection.shard = { index: 1, total: 1, suite: digest('suite'), files: {} };
  writeFileSync(shard, JSON.stringify(input));
  result = invoke(shard);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /merge shards before mutation/);
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2;\n');
  result = invoke();
  assert.equal(result.status, 3);
  assert.match(result.stderr, /hash does not match/);
});

test('mutate --base-input re-runs survivors that base detected (K7)', (t) => {
  const root = project(t), out = join(root, 'input.json'), mutated = join(root, 'mutated.json'), base = join(root, 'base.json');
  const r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  const mutant = { id: 'm1', source: 'src/value.mjs', line: 1, operator: 'literal', status: 'survived', killedBy: [] };
  const stub = join(root, 'mutator.mjs');
  writeFileSync(stub, `const m = ${JSON.stringify(mutant)};
export async function mutateNode() { return { mutants: [m], targeted: [] }; }
export async function confirmSurvivors({ mutation, ids }) {
  return { ...mutation, mutants: mutation.mutants.map((x) => ids.includes(x.id) ? { ...x, status: 'killed', killedBy: [] } : x) };
}
`);
  const env = { ...process.env, NODE_ENV: 'test', CUPEL_TEST_MUTATOR: stub };
  const invoke = (...extra) => spawnSync(process.execPath, [BIN, 'mutate', '--input', out, '--out', mutated, '--quiet', ...extra], { cwd: root, env, encoding: 'utf8' });
  let result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(mutated).mutation.mutants[0].status, 'survived');
  writeFileSync(base, JSON.stringify({ ...read(out), mutation: { mutants: [{ ...mutant, status: 'killed' }], targeted: [] } }));
  result = invoke('--base-input', base);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(mutated).mutation.mutants[0].status, 'killed');
  writeFileSync(base, '{"spec":"cupel-spec/1"}');
  result = invoke('--base-input', base);
  assert.equal(result.status, 2);
});

test('mutate runs the real Node mutator on a precollected input', (t) => {
  const root = project(t), out = join(root, 'input.json'), mutated = join(root, 'mutated.json');
  writeFileSync(join(root, 'src/auth.mjs'), 'export function allowed(x) { return x > 0; }\n');
  writeFileSync(join(root, 'tests/auth.test.mjs'), "import { test } from 'node:test'; import { allowed } from '../src/auth.mjs'; test('allowed', () => { if (!allowed(1)) throw Error('not allowed'); });\n");
  writeFileSync(join(root, 'cupel.json'), '{"mutation":{"critical":true,"maxMutants":1,"maxSeconds":60}}\n');
  let r = run(root, 'collect-node', '--out', out, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  r = run(root, 'mutate', '--input', out, '--out', mutated, '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(mutated).mutation.mutants.length, 1);
  assert.equal(readFileSync(join(root, 'src/auth.mjs'), 'utf8'), 'export function allowed(x) { return x > 0; }\n');
});

test('guard CLI warns on one run and refuses subset head', (t) => {
  const root = project(t), base = join(root, 'base.json'), subset = join(root, 'subset.json');
  assert.equal(run(root, 'collect-node', '--out', base, '--quiet').status, 0);
  let r = run(root, 'guard', '--base-input', base, '--head-input', base, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagnostics.map((d) => d.code), ['single-run', 'single-run']);
  assert.equal(run(root, 'collect-node', '--tests', 'tests/a.test.mjs', '--out', subset, '--quiet').status, 0);
  r = run(root, 'guard', '--base-input', base, '--head-input', subset, '--json');
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagnostics.map((d) => d.code), ['subset-input']);
});

test('node pass-through normalises short loader flags to their long forms', () => {
  assert.deepEqual(nodeFlags(['-r', './a.cjs', '-C', 'dev', '--import', 'tsx', '--test-concurrency=2']),
    ['--require=./a.cjs', '--conditions=dev', '--import=tsx', '--test-concurrency=2']);
});
