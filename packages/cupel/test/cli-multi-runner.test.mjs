import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSchemas } from '../src/cli/context.mjs';
import { run } from '../src/engine/index.mjs';
import { mergeRunners } from '../src/cli/merge-runners.mjs';
import { mutate, collectRef } from '../src/cli/collect.mjs';
import { detectRunners, detectedNodeFiles } from '../src/cli/runner-discovery.mjs';
import { callTool } from '../src/mcp/tools.mjs';
import { TEST_PYTHON } from './support/python-paths.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bin = join(repo, 'packages/cupel/bin/cupel.mjs');
const python = TEST_PYTHON;
const scratch = join(repo, '.scratch');
// A mutation root of its own: the reuse basis hashes every file under the root, and the shared .scratch holds files
// other tests are writing (on Windows, locked: EBUSY).
function ownRoot(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'multi-runner-mutate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const schemas = loadSchemas();

function fixture(second) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, `mixed-${second}-`));
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(root, 'src/math.mjs'), 'export const plus = (a, b) => a + b;\n');
  writeFileSync(join(root, 'tests/math.test.mjs'), "import { test } from 'node:test'; import { strict as assert } from 'node:assert'; import { plus } from '../src/math.mjs'; test('plus', () => assert.equal(plus(1, 2), 3));\n");
  if (second === 'pytest') {
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\naddopts = "-p no:cacheprovider"\n');
    writeFileSync(join(root, 'src/math.py'), 'def plus(a, b):\n    return a + b\n');
    writeFileSync(join(root, 'tests/test_math.py'), 'from src.math import plus\n\ndef test_plus():\n    assert plus(1, 2) == 3\n');
  } else {
    writeFileSync(join(root, 'go.mod'), 'module example.com/cupel-mixed\n\ngo 1.22\n');
    writeFileSync(join(root, 'math.go'), 'package mixed\nfunc Plus(a, b int) int { return a + b }\n');
    writeFileSync(join(root, 'math_test.go'), 'package mixed\nimport "testing"\nfunc TestPlus(t *testing.T) { if Plus(1, 2) != 3 { t.Fatal("wrong") } }\n');
  }
  return root;
}

function collect(root, config) {
  if (config) writeFileSync(join(root, 'cupel.json'), JSON.stringify(config));
  const output = join(root, 'input.json');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PATH: `${dirname(python)}${delimiter}${process.env.PATH}`,
    GOCACHE: join(root, '.scratch/go-cache'), GOPATH: join(root, '.scratch/go-path'), GOPROXY: 'off', GOSUMDB: 'off' };
  const result = spawnSync(process.execPath, [bin, 'label', '--runs', '1', '--out', output], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(readFileSync(output, 'utf8'));
}

for (const second of ['pytest', 'go']) {
  test(`auto-detects and collects node plus ${second}`, () => {
    const root = fixture(second);
    try {
      const input = collect(root);
      assert.deepEqual(input.runtimes.map((r) => r.runner), ['node', second]);
      assert.deepEqual(new Set(input.tests.map((t) => t.runner)), new Set(['node', second]));
      assert.equal(run('validate', { input }, {}, {}, schemas).exit, 0);
      const configured = collect(root, { runners: { node: { tests: 'tests/*.test.mjs' }, [second]: second === 'pytest' ? { collector: `"${python}" -m vibernt_cupel collect`, env: { PYTHONDONTWRITEBYTECODE: '1', PYTEST_ADDOPTS: '-p no:cacheprovider' } } : {} } });
      assert.deepEqual(configured.runtimes.map((r) => r.runner), ['node', second]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('merge rejects duplicate test ids and disagreeing source hashes', () => {
  const input = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
  assert.throws(() => mergeRunners([{ name: 'one', input }, { name: 'two', input }]), /duplicate test id/);
  const changed = structuredClone(input);
  const source = Object.keys(changed.sources)[0];
  changed.sources[source].hash = 'different';
  assert.throws(() => mergeRunners([{ name: 'one', input }, { name: 'two', input: changed }]), /source hash/);
});

test('merge unions source and setup lines and refuses mixed coverage granularity', () => {
  const input = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
  const other = structuredClone(input);
  const source = Object.keys(other.sources)[0];
  other.tests = other.tests.map((t) => ({ ...t, id: `other/${t.id}` }));
  other.coverage.byTest = Object.fromEntries(Object.entries(other.coverage.byTest ?? {}).map(([id, entry]) => [`other/${id}`, entry]));
  other.sources[source].coverable = '11';
  other.coverage.setup = { 'tests/other.test.mjs': { [source]: '11' } };
  const merged = mergeRunners([{ name: 'first', input }, { name: 'second', input: other }]);
  assert.equal(merged.sources[source].coverable, '1-11');
  assert.equal(merged.coverage.setup['tests/other.test.mjs'][source], '11');
  other.coverage.granularity = 'file';
  assert.throws(() => mergeRunners([{ name: 'first', input }, { name: 'second', input: other }]), /cannot represent both granularities/);
  input.coverage.granularity = 'file';
  assert.equal(mergeRunners([{ name: 'first', input }, { name: 'second', input: other }]).coverage.granularity, 'file');
});

test('CLI reports duplicate ids and names a failing runner as environment errors', () => {
  const root = fixture('go');
  try {
    const sample = readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8');
    const stub = join(root, 'collector.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[process.argv.indexOf('--out') + 1], ${JSON.stringify(sample)});\n`);
    const command = `"${process.execPath}" "${stub}"`;
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { one: { collector: command }, two: { collector: command } } }));
    const duplicate = spawnSync(process.execPath, [bin, 'label', '--runs', '1'], { cwd: root, encoding: 'utf8' });
    assert.equal(duplicate.status, 3);
    assert.match(duplicate.stderr, /duplicate test id/);
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { one: { collector: command }, broken: { collector: 'false' } } }));
    const failed = spawnSync(process.execPath, [bin, 'label', '--runs', '1'], { cwd: root, encoding: 'utf8' });
    assert.equal(failed.status, 3);
    assert.match(failed.stderr, /runner broken collection failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('guard compares each shared runner independently', () => {
  const input = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/060-report-several-runners/input.json'), 'utf8'));
  const head = structuredClone(input);
  head.runtimes[1].version = '3.14.0';
  assert.equal(run('guard', { base: input, head }, {}, {}, schemas).exit, 3);
  assert.match(run('guard', { base: input, head }, {}, {}, schemas).report.diagnostics[0].message, /pytest/);
});

test('I2 rejects missing and repeated runner membership', () => {
  const input = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/060-report-several-runners/input.json'), 'utf8'));
  delete input.tests[0].runner;
  assert.deepEqual(run('report', { input }, {}, {}, schemas).report.diagnostics.map((d) => d.code), ['unknown-runner']);
  input.tests[0].runner = 'vitest';
  input.runtimes.push({ ...input.runtimes[0] });
  assert.deepEqual(run('report', { input }, {}, {}, schemas).report.diagnostics.map((d) => d.code), ['unknown-runner']);
});

test('mutation runs independently for each supported runner', async (t) => {
  const source = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
  const a = structuredClone(source), b = structuredClone(source);
  b.tests = b.tests.map((t) => ({ ...t, id: `other/${t.id}` }));
  b.coverage.byTest = Object.fromEntries(Object.entries(b.coverage.byTest ?? {}).map(([id, entry]) => [`other/${id}`, entry]));
  b.sources = Object.fromEntries(Object.entries(b.sources).map(([path, entry]) => [`other/${path}`, entry]));
  const input = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  const seen = [];
  const mutator = { async mutateNode({ input: part }) {
    seen.push(part.tests[0].id);
    return { mutants: [{ id: `m-${seen.length}`, source: Object.keys(part.sources)[0], line: 1, operator: 'body-replace', status: 'survived' }], targeted: [] };
  } };
  const mutation = await mutate(mutator, { root: ownRoot(t), cfg: { runners: { node: {}, vitest: {} } }, input, scope: { critical: true }, log: () => {} });
  assert.equal(seen.length, 2);
  assert.deepEqual(mutation.mutants.map((m) => m.id), ['m-1', 'm-2']);
});

test('assertions records the supported runner and notes the skipped runner', () => {
  const root = fixture('pytest');
  try {
    const output = join(root, 'assertions-input.json');
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PATH: `${python.slice(0, python.lastIndexOf('/'))}:${process.env.PATH}` };
    const result = spawnSync(process.execPath, [bin, 'assertions', '--json', '--out', output], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.skippedRunners, ['pytest']);
    assert.ok(report.units.length);
    const replay = spawnSync(process.execPath, [bin, 'assertions', '--json', '--input', output], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), report);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native Node runner credits TypeScript source lines', () => {
  const root = fixture('go');
  try {
    writeFileSync(join(root, 'src/typed.ts'), 'export function double(value: number): number { return value * 2; }\n');
    writeFileSync(join(root, 'tests/typed.test.ts'), "import { test } from 'node:test'; import { strict as assert } from 'node:assert'; import { double } from '../src/typed.ts'; test('double', () => assert.equal(double(2), 4));\n");
    const input = collect(root, { runners: { node: { tests: 'tests/*.test.ts' } } });
    assert.ok(input.sources['src/typed.ts']);
    assert.ok(Object.values(input.coverage.byTest).some((entry) => entry['src/typed.ts']));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pseudo runs supported evidence and names skipped merged runners', () => {
  const root = fixture('go');
  try {
    const env = { ...process.env, GOCACHE: join(root, '.scratch/go-cache'), GOPATH: join(root, '.scratch/go-path'), GOPROXY: 'off', GOSUMDB: 'off' };
    const result = spawnSync(process.execPath, [bin, 'pseudo', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).skippedRunners, ['go']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nested Cargo collector paths are prefixed before merging', () => {
  const root = fixture('go');
  try {
    mkdirSync(join(root, 'src-tauri'));
    const sample = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
    sample.runtime = { name: 'rust', version: '1.91.0' };
    const stub = join(root, 'cargo-stub.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[process.argv.indexOf('--out') + 1], ${JSON.stringify(JSON.stringify(sample))});\n`);
    const input = collect(root, { runners: { cargo: { project: 'src-tauri', collector: `"${process.execPath}" "${stub}"` } } });
    assert.ok(input.sources['src-tauri/src/a.mjs']);
    assert.ok(input.tests.every((t) => t.id.startsWith('src-tauri/')));
    assert.equal(run('validate', { input }, {}, {}, schemas).exit, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('discovery distinguishes node:test from Vitest in one repository', () => {
  const root = fixture('go');
  try {
    writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: {} };\n');
    writeFileSync(join(root, 'tests/vitest.test.mjs'), "import { test } from 'vitest'; test('vitest', () => {});\n");
    assert.deepEqual(detectRunners(root, {}), ['vitest', 'node', 'go']);
    assert.deepEqual(detectedNodeFiles(root), ['tests/math.test.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MCP report retains runner runtimes for a merged input', async () => {
  const root = fixture('go');
  try {
    const input = join(root, 'merged.json');
    writeFileSync(input, readFileSync(join(repo, 'spec/conformance/cases/060-report-several-runners/input.json')));
    const response = await callTool('cupel_report', { input }, { root, env: process.env });
    assert.equal(response.isError, false);
    assert.deepEqual(JSON.parse(response.content[1].text).runtimes.map((r) => r.runner), ['vitest', 'pytest']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report, check, guard, plan and label read merged inputs', () => {
  const root = fixture('pytest');
  try {
    const input = join(root, 'merged.json');
    writeFileSync(input, readFileSync(join(repo, 'spec/conformance/cases/060-report-several-runners/input.json')));
    const cases = [
      ['report', '--input', input], ['label', '--input', input], ['plan', '--input', input],
      ['check', 'tests/a.test.mjs::a', '--input', input],
      ['guard', '--base-input', input, '--head-input', input],
    ];
    for (const args of cases) {
      const result = spawnSync(process.execPath, [bin, ...args, '--json'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.runtimes.length, 2, args[0]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('git-ref collection merges both configured runners', async () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'ref-runners-'));
  try {
    const input = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
    const stub = join(root, 'collector.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';
const name = process.argv[2]; const input = ${JSON.stringify(input)};
input.tests = input.tests.map(t => ({ ...t, id: name + '/' + t.id }));
input.coverage.byTest = Object.fromEntries(Object.entries(input.coverage.byTest).map(([id, value]) => [name + '/' + id, value]));
writeFileSync(process.argv[process.argv.indexOf('--out') + 1], JSON.stringify(input));\n`);
    const cfg = { runners: {
      alpha: { collector: `"${process.execPath}" "${stub}" alpha` },
      beta: { collector: `"${process.execPath}" "${stub}" beta` },
    } };
    const merged = await collectRef({ root: repo, ref: 'HEAD', cfg, runs: 1, log: () => {} });
    assert.deepEqual(merged.runtimes.map((r) => r.runner), ['alpha', 'beta']);
    assert.equal(run('guard', { base: merged, head: merged }, {}, {}, schemas).exit, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Issue 7: two JavaScript runners (node:test and Vitest) testing one shared source plant the same mutants.
function sharedSourceInput() {
  const source = JSON.parse(readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8'));
  const a = structuredClone(source), b = structuredClone(source);
  b.tests = b.tests.map((t) => ({ ...t, id: `web/${t.id}`, file: `web/${t.file}`, ...(t.unit ? { unit: `web/${t.unit}` } : {}) }));
  b.coverage.byTest = Object.fromEntries(Object.entries(b.coverage.byTest ?? {}).map(([id, entry]) => [`web/${id}`, entry]));
  b.coverage.setup = {};
  return { input: mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]), a, b };
}

test('runners sharing a source give one combined row per mutant: caught if any runner catches it (issue 7)', async (t) => {
  const { input, a, b } = sharedSourceInput();
  const path = Object.keys(a.sources)[0];
  const covered = Object.values(a.coverage.byTest)[0][path];
  const line = Number(String(covered).split(/[,-]/)[0]);
  const nodeTest = a.tests[0].id, webTest = b.tests[0].id;
  const rows = {
    node: [
      { id: 'm-caught-by-web', source: path, line, operator: 'cmp-flip', status: 'survived', durationMs: 5 },
      { id: 'm-both-survive', source: path, line, operator: 'arith', status: 'survived', durationMs: 4 },
      { id: 'm-node-only', source: path, line, operator: 'negate-cond', status: 'killed', killedBy: [nodeTest], killKinds: { [nodeTest]: 'assertion' } },
    ],
    vitest: [
      { id: 'm-caught-by-web', source: path, line, operator: 'cmp-flip', status: 'killed', killedBy: [webTest], killKinds: { [webTest]: 'assertion' }, durationMs: 7 },
      { id: 'm-both-survive', source: path, line, operator: 'arith', status: 'survived', durationMs: 6 },
      { id: 'm-node-only', source: path, line, operator: 'negate-cond', status: 'no-coverage' },
    ],
  };
  const mutator = { async mutateNode({ input: part }) {
    const name = part.tests[0].id.startsWith('web/') ? 'vitest' : 'node';
    return { mutants: rows[name], targeted: [], sampled: false, seed: 1 };
  } };
  const mutation = await mutate(mutator, { root: ownRoot(t), cfg: { runners: { node: {}, vitest: {} } }, input, scope: { critical: true }, log: () => {} });
  const byId = Object.fromEntries(mutation.mutants.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), ['m-both-survive', 'm-caught-by-web', 'm-node-only']);
  assert.equal(byId['m-caught-by-web'].status, 'killed');
  assert.deepEqual(byId['m-caught-by-web'].killedBy, [webTest]);
  assert.equal(byId['m-caught-by-web'].durationMs, 12);
  assert.equal(byId['m-both-survive'].status, 'survived');
  assert.equal(byId['m-node-only'].status, 'killed');
  assert.deepEqual(byId['m-node-only'].killedBy, [nodeTest]);
  assert.equal(mutation.sampled, false);
  assert.equal(new Set(mutation.mutants.map((m) => m.id)).size, mutation.mutants.length);
});

test('a mutant one covering runner did not run, and nobody caught, is left out and the result is sampled (issue 7)', async (t) => {
  const { input, a } = sharedSourceInput();
  const path = Object.keys(a.sources)[0];
  const line = Number(String(Object.values(a.coverage.byTest)[0][path]).split(/[,-]/)[0]);
  const mutator = { async mutateNode({ input: part }) {
    const web = part.tests[0].id.startsWith('web/');
    // Vitest's sample left `m-partial` out; node:test ran it and it survived there.
    return { mutants: web ? [] : [{ id: 'm-partial', source: path, line, operator: 'arith', status: 'survived' }], targeted: [], sampled: web };
  } };
  const mutation = await mutate(mutator, { root: ownRoot(t), cfg: { runners: { node: {}, vitest: {} } }, input, scope: { critical: true }, log: () => {} });
  assert.deepEqual(mutation.mutants, []);
  assert.equal(mutation.sampled, true);
});

test('merging saved runner inputs combines their shared mutants instead of refusing them (issue 7)', () => {
  const { a, b } = sharedSourceInput();
  const path = Object.keys(a.sources)[0];
  const line = Number(String(Object.values(a.coverage.byTest)[0][path]).split(/[,-]/)[0]);
  a.mutation = { mutants: [{ id: 'm', source: path, line, operator: 'arith', status: 'survived' }], targeted: [] };
  b.mutation = { mutants: [{ id: 'm', source: path, line, operator: 'arith', status: 'killed', killedBy: [b.tests[0].id] }], targeted: [] };
  const merged = mergeRunners([{ name: 'node', input: a }, { name: 'vitest', input: b }]);
  assert.deepEqual(merged.mutation.mutants.map((m) => [m.id, m.status, m.killedBy]), [['m', 'killed', [b.tests[0].id]]]);
});
