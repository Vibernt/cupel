import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHeavyFixture, jestFixture } from './fixtures.mjs';
import { makeProject } from '../../../packages/cupel/test/mutate-helpers.mjs';
import { collectNode } from '../../../packages/cupel/src/collect/node/index.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(process.argv[2] ?? '');
if (!out.startsWith(join(repo, '.scratch/s17/'))) throw new Error('output must be under .scratch/s17');
mkdirSync(out, { recursive: false });
const pre = JSON.parse(readFileSync(join(repo, `.scratch/s17/baseline-node${process.versions.node.split('.')[0]}/baseline.json`)));
if (pre.runtime !== process.version) throw new Error('pre-change baseline runtime mismatch');
const cases = {};
const fingerprints = {};
function save(name, root, input, options, metadata, files) {
  cases[name] = join(out, `${name}.json`);
  writeFileSync(cases[name], JSON.stringify({ root, input, options, metadata }, null, 2));
  fingerprints[name] = Object.fromEntries(files.map(file => [file,
    createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
}
const node = makeProject();
const nodeRoot = join(out, 'node-project');
try { cpSync(node.root, nodeRoot, { recursive: true }); } finally { node.cleanup(); }
save('node-existing', nodeRoot, pre.cases['node-synthetic'].input,
  pre.cases['node-synthetic'].options, { type: 'existing mutation test fixture' },
  ['package.json', 'src/calc.mjs', 'src/guard.mjs', 'tests/calc.test.mjs', 'tests/guard.test.mjs']);

if (!existsSync(join(jestFixture, 'node_modules/jest/package.json'))) throw new Error('pinned Jest fixture is not installed');
const jestRoot = join(out, 'jest-project');
mkdirSync(jestRoot);
for (const name of ['package.json', 'package-lock.json', 'jest.config.cjs', 'transform.cjs',
  'src/math.cjs', 'src/typed.ts', 'tests/math.test.cjs', 'tests/typed.test.ts']) {
  const target = join(jestRoot, name);
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(join(jestFixture, name), target);
}
symlinkSync(join(jestFixture, 'node_modules'), join(jestRoot, 'node_modules'), 'dir');
save('jest-existing', jestRoot, pre.cases['jest-existing'].input,
  pre.cases['jest-existing'].options, { type: 'existing pinned Jest conformance fixture', testFiles: 2 },
  ['package.json', 'package-lock.json', 'jest.config.cjs', 'transform.cjs',
    'src/math.cjs', 'src/typed.ts', 'tests/math.test.cjs', 'tests/typed.test.ts']);

const heavyRoot = join(out, 'source-heavy-project');
const heavy = sourceHeavyFixture(heavyRoot);
const collected = await collectNode({ root: heavyRoot, runs: 2 });
if (collected.tests.length !== heavy.input.tests.length || collected.tests.some(t => t.status !== 'passed'))
  throw new Error('source-heavy full collector oracle did not pass all three tests');
save('source-heavy', heavyRoot, collected, heavy.options,
  { ...heavy.metadata, collector: 'actual node:test', collectionRuns: 2 },
  ['package.json', 'src/lookup.mjs', 'tests/lookup.test.mjs']);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ runtime: process.version, cases, fingerprints,
  baseline: pre.runtime }, null, 2));
process.stdout.write(JSON.stringify({ runtime: process.version, cases: Object.keys(cases), heavy: heavy.metadata }) + '\n');
