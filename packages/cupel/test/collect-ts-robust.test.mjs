import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { scanSources } from '../src/collect/vitest/sources.mjs';
import { enumerateSites } from '../src/mutate/sites.mjs';
import { main } from '../src/cli/main.mjs';
import { collectNode } from '../src/collect/node/index.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitest = '/Users/vid/codecrystal/hub-ts/node_modules/vitest';
const typescript = '/Users/vid/codecrystal/hub-ts/node_modules/typescript';

function project(withTypeScript) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/ts-robust-'));
  for (const dir of ['node_modules', 'src', 'tests']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  writeFileSync(join(root, 'vitest.config.mjs'), 'export default {};\n');
  symlinkSync(vitest, join(root, 'node_modules/vitest'));
  if (withTypeScript) symlinkSync(typescript, join(root, 'node_modules/typescript'));
  writeFileSync(join(root, 'src/errors.ts'), `export enum Level { Low, High }
export class Failure {
  constructor(private level: Level) {}
  isHigh() { return this.level === Level.High; }
}
`);
  writeFileSync(join(root, 'src/other.ts'), 'export function other(x: number) { return x > 0; }\n');
  writeFileSync(join(root, 'tests/errors.test.ts'), `import { test, expect } from 'vitest';
import { Failure, Level } from '../src/errors';
import { other } from '../src/other';
class Probe { constructor(private value: number) {} get() { return this.value; } }
test('high', () => { expect(new Failure(Level.High).isHigh()).toBe(true); expect(other(1)).toBe(true); expect(new Probe(1).get()).toBe(1); });
`);
  return root;
}

test('transform-only TS is classified and yields mutation sites with project TypeScript',
  { skip: !existsSync(vitest) || !existsSync(typescript) }, async (t) => {
    const root = project(true);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const diagnostics = [];
    const input = await collectVitest({ root, runs: 1, diagnostics });
    assert.deepEqual(diagnostics, []);
    assert.ok(input.sources['src/errors.ts'].coverable);
    assert.ok(input.coverage.byTest['tests/errors.test.ts::high']['src/errors.ts']);
    const lines = new Map([['src/errors.ts', new Set([1, 4])]]);
    const sites = await enumerateSites({ root, lines, log: () => {}, diagnostics });
    assert.ok(sites.candidates.some((m) => m.source === 'src/errors.ts'));
    assert.ok(sites.candidates.every((m) => m.mode === 'typescript-scanned'));
  });

test('transform-only TS is skipped once without project TypeScript while other files collect',
  { skip: !existsSync(vitest) }, async (t) => {
    const root = project(false);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const diagnostics = [], logs = [];
    const input = await collectVitest({ root, runs: 1, diagnostics, log: (s) => logs.push(s) });
    assert.equal(input.sources['src/errors.ts'], undefined);
    assert.ok(input.sources['src/other.ts']);
    assert.deepEqual(diagnostics.map((d) => d.file), ['src/errors.ts', 'tests/errors.test.ts']);
    assert.equal(logs.filter((s) => s.includes('skipped src/errors.ts')).length, 1);
  });

test('a lexer error skips one source and preserves its neighbour', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/lexer-robust-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/bad.js'), 'export const bad = `unterminated\n');
    writeFileSync(join(root, 'src/good.js'), 'export const good = 1;\n');
    const diagnostics = [], logs = [];
    const sources = scanSources(root, {}, (s) => logs.push(s), diagnostics);
    assert.deepEqual([...sources.keys()], ['src/good.js']);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].file, 'src/bad.js');
    assert.match(logs[0], /Unterminated template literal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TypeScript without createScanner skips transform-only TS and keeps other files', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/ts-no-scanner-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules/typescript'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"version":"7.0.0","main":"index.cjs"}');
    writeFileSync(join(root, 'node_modules/typescript/index.cjs'), 'exports.createSourceFile = () => {};\n');
    writeFileSync(join(root, 'src/errors.ts'), 'export class ErrorBox { constructor(private code: number) {} }\n');
    writeFileSync(join(root, 'src/good.ts'), 'export const good: number = 1;\n');
    const diagnostics = [];
    const sources = scanSources(root, {}, () => {}, diagnostics);
    assert.deepEqual([...sources.keys()], ['src/good.ts']);
    assert.deepEqual(diagnostics.map((d) => d.file), ['src/errors.ts']);
    assert.match(diagnostics[0].cause, /does not expose createScanner/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one uncollectable Vitest module does not stop another test file',
  { skip: !existsSync(vitest) }, async (t) => {
    const root = project(false);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'tests/broken.test.ts'), "import '../src/missing';\n");
    const diagnostics = [];
    const input = await collectVitest({ root, runs: 1, diagnostics });
    assert.ok(input.tests.some((row) => row.name === 'high'));
    assert.ok(diagnostics.some((row) => row.file === 'tests/broken.test.ts'));
  });

test('CLI writes skipped.json beside --out and keeps the input schema clean',
  { skip: !existsSync(vitest) }, async (t) => {
    const root = project(false);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    let err = '';
    const exit = await main(['report', '--runs', '1', '--no-mutation', '--out', '.cupel/input.json', '--json'],
      { cwd: root, env: process.env, colour: false, out: () => {}, err: (s) => { err += s; } });
    assert.equal(exit, 0, err);
    const skipped = JSON.parse(readFileSync(join(root, '.cupel/skipped.json'), 'utf8'));
    assert.deepEqual(skipped.skipped.map((row) => row.file), ['src/errors.ts', 'tests/errors.test.ts']);
    assert.match(err, /2 files skipped: see .cupel\/skipped.json/);
    assert.equal(JSON.parse(readFileSync(join(root, '.cupel/input.json'), 'utf8')).skipped, undefined);
  });

test('Node collection skips a lexer failure and retains coverage for another source', async (t) => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/node-robust-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'src/bad.js'), 'export const bad = `unterminated\n');
  writeFileSync(join(root, 'src/good.mjs'), 'export const good = (x) => x > 0;\n');
  writeFileSync(join(root, 'tests/good.test.mjs'), `import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { good } from '../src/good.mjs';
test('good', () => { assert.equal(good(1), true); });
`);
  const diagnostics = [];
  const input = await collectNode({ root, runs: 1, diagnostics });
  assert.deepEqual(diagnostics.map((d) => d.file), ['src/bad.js']);
  assert.ok(input.sources['src/good.mjs']);
  assert.equal(input.sources['src/bad.js'], undefined);
  assert.ok(input.coverage.byTest['tests/good.test.mjs::good']['src/good.mjs']);
});

test('mutation site enumeration skips one lexer failure and keeps other sites', async (t) => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/mutate-robust-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/bad.js'), 'export const bad = `unterminated\n');
  writeFileSync(join(root, 'src/good.mjs'), 'export const good = (x) => x > 0;\n');
  const diagnostics = [];
  const sites = await enumerateSites({ root, lines: new Map([
    ['src/bad.js', new Set([1])], ['src/good.mjs', new Set([1])],
  ]), log: () => {}, diagnostics });
  assert.deepEqual(diagnostics.map((d) => d.file), ['src/bad.js']);
  assert.ok(sites.candidates.some((m) => m.source === 'src/good.mjs'));
});
