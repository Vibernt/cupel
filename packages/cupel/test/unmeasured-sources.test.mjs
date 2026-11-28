// Issue 9: sources a runner cannot measure are listed apart, never dropped and never blamed on the project's syntax;
// TypeScript declaration files are not sources at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode, JSX_NO_MAP, JSX_NOT_LOADED } from '../src/collect/node/index.mjs';
import { scanSources } from '../src/collect/vitest/sources.mjs';
import { isDeclarationFile } from '../src/lang/js/declaration.mjs';
import { formatReport } from '../src/cli/human.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const load = (name) => JSON.parse(readFileSync(new URL(`../../../spec/schemas/${name}`, import.meta.url), 'utf8'));
const schemas = { input: load('input.schema.json'), config: load('config.schema.json'), report: load('report.schema.json') };
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const plain = { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s };

const FILES = {
  'src/price.mjs': 'export function price(amount, percent) {\n  if (percent > 0 && percent <= 100) return amount - (amount * percent) / 100;\n  return amount;\n}\n',
  'src/price.d.ts': 'export declare function price(amount: number, percent: number): number;\nexport interface Options {\n  round?: boolean;\n}\n',
  'src/types.d.mts': 'export type Id = string;\n',
  'src/view.tsx': 'export function View({ name }: { name: string }) {\n  return <p className="greeting">Hello, {name}</p>;\n}\n',
  'src/plain.jsx': 'export const Badge = ({ label }) => <span>{label}</span>;\n',
  'tests/price.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { price } from '../src/price.mjs';\ntest('a discount is taken off', () => { assert.equal(price(100, 10), 90); });\n",
};

function project(extra = {}) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/unmeasured-'));
  for (const [file, text] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

test('declaration files are recognised, other TypeScript is not', () => {
  for (const f of ['a.d.ts', 'src/a.d.mts', 'src/a.d.cts', 'src/styles.d.css.ts']) assert.equal(isDeclarationFile(f), true, f);
  for (const f of ['a.ts', 'src/d.ts', 'src/add.ts', 'src/a.d.tsx', 'src/a.d.js', 'src/odd.ts']) assert.equal(isDeclarationFile(f), false, f);
});

test('node:test lists JSX as unmeasured with its reason, leaves declarations out and keeps unreadable files apart', async () => {
  const root = project({ 'src/bad.js': 'export const bad = `unterminated\n' });
  try {
    const diagnostics = [], logs = [];
    const input = await collectNode({ root, config: {}, runs: 1, log: (s) => logs.push(s), diagnostics });
    assert.deepEqual(Object.keys(input.sources), ['src/bad.js', 'src/plain.jsx', 'src/price.mjs', 'src/view.tsx']);
    for (const file of ['src/plain.jsx', 'src/view.tsx'])
      assert.deepEqual(input.sources[file], { coverable: '', hash: sha(FILES[file]), unmeasured: JSX_NOT_LOADED });
    assert.equal(input.sources['src/price.mjs'].coverable, '1-4');
    assert.equal(input.sources['src/bad.js'].coverable, '');
    assert.match(input.sources['src/bad.js'].unmeasured, /^not read by the node:test runner: Unterminated template/);
    // Only the unreadable file is a skip; JSX is a runner limit, never reported as the project's syntax error.
    assert.deepEqual(diagnostics.map((d) => d.file), ['src/bad.js']);
    assert.ok(!logs.some((l) => /regex/i.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('2 JSX sources not measured') && l.includes('src/plain.jsx, src/view.tsx')), logs.join('\n'));
    assert.deepEqual(validate(schemas.input, input), []);

    const { report, exit } = run('report', { input }, {}, {}, schemas);
    assert.equal(exit, 0, JSON.stringify(report.diagnostics));
    assert.deepEqual(report.suite.coverage, { covered: 3, coverable: 4, pct: 75 });
    assert.equal(report.suite.unmeasured, 3);
    assert.match(formatReport('report', report, plain), /coverage 75% \(3\/4\), 3 sources not measured, mutation score/);

    const audit = run('audit', { input }, {}, {}, schemas);
    assert.equal(audit.exit, 0);
    assert.deepEqual(audit.report.audit.coverage.unmeasured.map((u) => u.source), ['src/bad.js', 'src/plain.jsx', 'src/view.tsx']);
    const text = formatReport('audit', audit.report, plain);
    assert.match(text, /3 of 4 lines covered \(75%\); 3 sources not measured, listed below\./);
    assert.match(text, /- `src\/view\.tsx`: JSX not loaded by any test: node:test runs JSX only through a loader/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('strict collection (collect-node) accepts JSX sources: a runner limit is not an incomplete inventory', async () => {
  const root = project();
  try {
    const input = await collectNode({ root, config: {}, runs: 1, strict: true });
    assert.equal(input.sources['src/view.tsx'].unmeasured, JSX_NOT_LOADED);
    assert.equal(input.sources['src/price.d.ts'], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a report with every source measured has no unmeasured count', async () => {
  const root = project();
  try {
    for (const f of ['src/view.tsx', 'src/plain.jsx']) rmSync(join(root, f));
    const input = await collectNode({ root, config: {}, runs: 1 });
    const { report } = run('report', { input }, {}, {}, schemas);
    assert.equal('unmeasured' in report.suite, false);
    assert.match(formatReport('report', report, plain), /coverage 75% \(3\/4\), mutation score/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Vitest and Jest source scan: declarations are not sources; unreadable files are recorded as unmeasured', () => {
  const root = project({ 'src/bad.js': 'export const bad = `unterminated\n' });
  try {
    const diagnostics = [], unmeasured = new Map();
    // No TypeScript is resolvable from this project, so JSX cannot be read here.
    const sources = scanSources(root, { exclude: ['tests/**'] }, () => {}, diagnostics, unmeasured);
    assert.deepEqual([...sources.keys()], ['src/price.mjs']);
    assert.deepEqual([...unmeasured.keys()].sort(), ['src/bad.js', 'src/plain.jsx', 'src/view.tsx']);
    assert.equal(unmeasured.get('src/view.tsx').hash, sha(FILES['src/view.tsx']));
    assert.match(unmeasured.get('src/view.tsx').reason, /^not read by the Vitest runner: typescript is not resolvable/);
    assert.match(unmeasured.get('src/bad.js').reason, /Unterminated template/);
    assert.deepEqual(diagnostics.map((d) => d.file).sort(), ['src/bad.js', 'src/plain.jsx', 'src/view.tsx']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Review findings on the first version of this change.

test('a source that could not be measured stays in the reuse basis: its tests may run it unseen', async (t) => {
  const { ReuseBasis } = await import('../src/mutate/reuse.mjs');
  const { makeProject } = await import('./mutate-helpers.mjs');
  const p = makeProject({});
  t.after(p.cleanup);
  const row = { id: 'src/calc.mjs:2:9:cmp:abc', source: 'src/calc.mjs', line: 2, operator: 'cmp', status: 'killed' };
  const basis = (input) => new ReuseBasis({ root: p.root, input, cfg: {}, env: {} }).of(row);
  const unmeasured = { ...p.input, sources: { ...p.input.sources, 'src/guard.mjs': { coverable: '', hash: p.input.sources['src/guard.mjs'].hash, unmeasured: 'not read' } } };
  const before = { measured: basis(p.input), unmeasured: basis(unmeasured) };
  writeFileSync(join(p.root, 'src/guard.mjs'), `${readFileSync(join(p.root, 'src/guard.mjs'), 'utf8')}// edit\n`);
  assert.equal(basis(p.input), before.measured, 'a measured source no selected test covers is not read');
  assert.notEqual(basis(unmeasured), before.unmeasured, 'an unmeasured source is');
});

test('combining runners: JSX no node:test test loaded takes the measuring runner\'s lines; a source run unseen is refused', async () => {
  const { mergeRunners } = await import('../src/cli/merge-runners.mjs');
  const { integrityDiagnostics } = await import('../src/engine/integrity.mjs');
  const part = (sources, test, lines) => ({
    spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '26.7.0' }, sources,
    tests: [{ id: test, file: test.split('::')[0], name: 'x', status: 'passed' }],
    coverage: { granularity: 'test', byTest: lines ? { [test]: lines } : {}, setup: {} },
  });
  const both = (a, b) => [[['node', a], ['vitest', b]], [['vitest', b], ['node', a]]].map((order) => mergeRunners(order.map(([name, input]) => ({ name, input }))));
  const node = part({
    'src/App.tsx': { coverable: '', hash: 'h1', unmeasured: JSX_NOT_LOADED },
    'src/Page.tsx': { coverable: '', hash: 'h4', unmeasured: JSX_NOT_LOADED },
    'src/lib.mjs': { coverable: '1-4', hash: 'h2' },
  }, 'tests/lib.test.mjs::x', { 'src/lib.mjs': '1-2' });
  const vitest = part({
    'src/App.tsx': { coverable: '1-3', hash: 'h1' },
    'src/Page.tsx': { coverable: '', hash: 'h4', unmeasured: 'not read by the Vitest runner: typescript is not resolvable from the project root' },
    'src/lib.mjs': { coverable: '1-4', hash: 'h2' },
  }, 'tests/App.test.tsx::x', { 'src/App.tsx': '1-3' });
  for (const merged of both(node, vitest)) {
    assert.deepEqual(merged.sources['src/App.tsx'], { coverable: '1-3', hash: 'h1' });
    assert.match(merged.sources['src/Page.tsx'].unmeasured, /typescript is not resolvable/, 'the reason that says most');
    assert.deepEqual(integrityDiagnostics(merged), []);
  }
  // Vitest's tests load lib.mjs but its coverage could not be mapped: they may catch faults node's tests miss.
  const unmapped = structuredClone(vitest);
  unmapped.sources['src/lib.mjs'] = { coverable: '', hash: 'h2', unmeasured: 'its coverage could not be mapped back to the file (transformed without a usable source map)' };
  for (const order of [[node, unmapped], [unmapped, node]])
    assert.throws(() => mergeRunners([{ name: 'a', input: order[0] }, { name: 'b', input: order[1] }]), /measures src\/lib\.mjs and another runs it without measuring it/);
  // A runner that could not read the file has no hash to compare, and no complete answer either.
  const unread = structuredClone(vitest);
  unread.sources['src/lib.mjs'] = { coverable: '', unmeasured: 'not read by the Vitest runner: EACCES' };
  assert.throws(() => mergeRunners([{ name: 'a', input: node }, { name: 'b', input: unread }]), /runs it without measuring it \(not read by the Vitest runner: EACCES\)/);
  // JSX node:test's tests loaded through a loader but could not map: they ran it unseen, so it is refused too.
  const loadedUnmapped = structuredClone(node);
  loadedUnmapped.sources['src/App.tsx'] = { coverable: '', hash: 'h1', unmeasured: `${JSX_NO_MAP}: evaluated script has no inline source map` };
  assert.throws(() => mergeRunners([{ name: 'a', input: loadedUnmapped }, { name: 'b', input: vitest }]), /measures src\/App\.tsx and another runs it without measuring it \(JSX loaded without a usable source map/);
});

test('reasons carry no machine paths and no line breaks', async () => {
  const { causeText } = await import('../src/collect/skipped.mjs');
  const denied = Object.assign(new Error("EACCES: permission denied, open '/home/me/project/src/x.mjs'"), { code: 'EACCES' });
  assert.equal(causeText(denied), 'EACCES');
  assert.equal(causeText(new Error('Unterminated regex\nat offset 3')), 'Unterminated regex at offset 3');
});

test('the experimental Node PR profile names JSX as the reason it refuses a .tsx, and ignores .jsx as before', async () => {
  const { profileSources } = await import('../src/pr/profiles/node/input-lines.mjs');
  const root = project({ 'src/typed.tsx': 'export const n: number = 1;\n' });
  try {
    const files = { ...FILES, 'src/typed.tsx': 'export const n: number = 1;\n' };
    const manifest = Object.fromEntries(Object.keys(files).map((f) => [f, sha(files[f])]));
    assert.throws(() => profileSources(root, manifest, new Set(['tests/price.test.mjs'])), /cannot measure JSX source: src\/view\.tsx/);
    const { 'src/view.tsx': _v, ...rest } = manifest;
    assert.deepEqual([...profileSources(root, rest, new Set(['tests/price.test.mjs'])).keys()], ['src/price.mjs', 'src/typed.tsx']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
