// Issue 9: sources a runner cannot measure are listed apart, never dropped and never blamed on the project's syntax;
// TypeScript declaration files are not sources at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode, JSX_UNMEASURED } from '../src/collect/node/index.mjs';
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
      assert.deepEqual(input.sources[file], { coverable: '', hash: sha(FILES[file]), unmeasured: JSX_UNMEASURED });
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
    assert.match(text, /- `src\/view\.tsx`: JSX is not measured by the node:test runner/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('strict collection (collect-node) accepts JSX sources: a runner limit is not an incomplete inventory', async () => {
  const root = project();
  try {
    const input = await collectNode({ root, config: {}, runs: 1, strict: true });
    assert.equal(input.sources['src/view.tsx'].unmeasured, JSX_UNMEASURED);
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
