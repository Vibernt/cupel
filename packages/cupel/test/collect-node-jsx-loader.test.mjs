// JSX under node:test runs only through a loader the project sets up. When one runs it with an inline source map,
// Cupel measures it (coverable lines from the project's TypeScript, coverage mapped back) and plants faults the
// loader transforms; anything it cannot show is listed as unmeasured or refused, never guessed or scored.
//
// The fixture's loader is written here: the project's own `typescript` (`transpileModule`) behind `module.register`
// (async, like tsx) or `registerHooks` (sync). It needs a resolvable TypeScript; the tests skip without one.
// CUPEL_TEST_TYPESCRIPT names a typescript package folder (default: the one in CUPEL_TEST_TSX, else the Vitest 4
// fixtures' copy). CUPEL_TEST_TSX names a node_modules folder holding tsx and typescript for one end-to-end run with a
// real loader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectNode, JSX_NO_MAP, JSX_NOT_LOADED } from '../src/collect/node/index.mjs';
import { mergeInputs } from '../src/cli/merge-inputs.mjs';
import { mutateNode } from '../src/mutate/index.mjs';
import { applyMutant } from '../src/mutate/operators.mjs';
import { sourceMutants } from '../src/mutate/sites.mjs';
import { markedSource, pidsAfter } from '../src/mutate/jsx-mark.mjs';
import { projectTypeScript, scanJsx } from '../src/lang/js/project-typescript.mjs';
import { formatLines } from '../src/collect/node/lines.mjs';
import { validate } from '../src/engine/schema.mjs';
import { integrityDiagnostics } from '../src/engine/integrity.mjs';
import { VITEST4_TYPESCRIPT } from './support/vitest-paths.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const inputSchema = JSON.parse(readFileSync(new URL('../../../spec/schemas/input.schema.json', import.meta.url), 'utf8'));
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
// Node 22 before 22.23 rejects CommonJS imports while sync and async module hooks are both registered.
const HOOK_BUG = NODE_MAJOR === 22 && NODE_MINOR < 23;
const TSX_MODULES = process.env.CUPEL_TEST_TSX;
const TYPESCRIPT = process.env.CUPEL_TEST_TYPESCRIPT ??
  (TSX_MODULES && existsSync(join(TSX_MODULES, 'typescript/package.json')) ? join(TSX_MODULES, 'typescript') : VITEST4_TYPESCRIPT);
const noTypeScript = existsSync(join(TYPESCRIPT, 'package.json')) ? false : `no TypeScript at ${TYPESCRIPT} (set CUPEL_TEST_TYPESCRIPT)`;
const noTsx = TSX_MODULES && existsSync(join(TSX_MODULES, 'tsx/package.json')) && existsSync(join(TSX_MODULES, 'typescript/package.json'))
  ? false : 'set CUPEL_TEST_TSX to a node_modules folder with tsx and typescript';

// The loader: JSX through typescript's transpileModule, with an inline map unless the file name says `nomap`.
// FIXTURE_LOADER=sync uses registerHooks; =own-read reads the file itself instead of the text it is handed.
const LOADER = {
  'loader/transform.mjs': `import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ts = createRequire(import.meta.url)('typescript');
export const isJsx = (url) => /\\.[jt]sx$/.test(url.split('?')[0]);
export function transform(url, source) {
  const fileName = fileURLToPath(url);
  const map = !fileName.includes('nomap');
  return ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, jsxFactory: 'h', inlineSourceMap: map, inlineSources: map } }).outputText;
}
export const text = (source) => typeof source === 'string' ? source : new TextDecoder().decode(source);
`,
  'loader/hooks.mjs': `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isJsx, text, transform } from './transform.mjs';
export async function load(url, context, nextLoad) {
  if (!isJsx(url)) return nextLoad(url, context);
  const loaded = await nextLoad(url, { ...context, format: 'module' });
  const source = process.env.FIXTURE_LOADER === 'own-read' ? readFileSync(fileURLToPath(url), 'utf8') : text(loaded.source);
  return { format: 'module', source: transform(url, source), shortCircuit: true };
}
`,
  'loader/register.mjs': `import { register, registerHooks } from 'node:module';
import { isJsx, text, transform } from './transform.mjs';
if (process.env.FIXTURE_LOADER === 'sync') {
  registerHooks({ load(url, context, next) {
    if (!isJsx(url)) return next(url, context);
    const loaded = next(url, { ...context, format: 'module' });
    return { format: 'module', source: transform(url, text(loaded.source)), shortCircuit: true };
  } });
} else register('./hooks.mjs', import.meta.url);
`,
};

const VIEW = `const h = (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props, children });
export function label(n: number): string {
  if (n > 1) return 'many';
  return 'one';
}
export function View({ n }: { n: number }) {
  return <p className="count">{label(n)}</p>;
}
export function unused(n: number) {
  return n * 2;
}
`;
const FILES = {
  'package.json': '{"private":true,"type":"module"}\n',
  'src/view.tsx': VIEW,
  'src/badge.jsx': "const h = (tag, props, ...children) => ({ tag, props, children });\nexport const Badge = ({ text }) =>\n  <b>{text.toUpperCase()}</b>;\n",
  'src/nomap.jsx': "const h = (tag, props, ...children) => ({ tag, props, children });\nexport const Plain = () => <i>plain</i>;\n",
  'src/idle.tsx': "const h = (tag: string) => ({ tag });\nexport const Idle = () => <hr />;\n",
  'src/price.mjs': 'export function price(amount, percent) {\n  return amount - (amount * percent) / 100;\n}\n',
  'tests/view.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { View, label } from '../src/view.tsx';
import { Badge } from '../src/badge.jsx';
import { Plain } from '../src/nomap.jsx';
import { price } from '../src/price.mjs';
test('many', () => { assert.equal(label(2), 'many'); });
test('view', () => { assert.equal(View({ n: 2 }).children[0], 'many'); });
test('badge', () => { assert.equal(Badge({ text: 'ok' }).children[0], 'OK'); assert.equal(Plain().tag, 'i'); });
test('price', () => { assert.equal(price(100, 10), 90); });
`,
  ...LOADER,
};

function project(files = FILES, modules = { typescript: TYPESCRIPT }) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/jsx-loader-'));
  for (const [file, text] of Object.entries(files)) {
    if (text === undefined) continue;
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const [name, path] of Object.entries(modules)) symlinkSync(path, join(root, 'node_modules', name));
  return root;
}

/** The environment for a plain `node --test` of a fixture, outside Cupel's own test run. */
const plainEnv = (extra) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

const configFor = (root, loader = 'async') => ({
  runners: { node: { tests: 'tests/**/*.test.mjs', env: { NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'loader/register.mjs')).href}`, FIXTURE_LOADER: loader } } },
});

test('a source mark goes after directives and leading comments, and moves no line', { skip: noTypeScript }, () => {
  const ts = projectTypeScript(project({ 'package.json': '{}' }));
  const opts = { mark: 'cupel-ran-x-1', ranPath: '/tmp/ran-1' };
  const cases = [
    ["'use client';\nimport a from 'a';\nexport const v = <a />;\n", "'use client';try{"],
    ['"use strict"\nexport const v = <a />;\n', '"use strict";try{'],
    ['#!/usr/bin/env node\n/** @jsx h */\n// note\nexport const v = <a />;\n', '#!/usr/bin/env node\n/** @jsx h */\n// note\ntry{'],
    ['export const v = <a />;\n', 'try{'],
  ];
  for (const [text, starts] of cases) {
    const out = markedSource(ts, 'src/x.tsx', text, opts);
    assert.ok(out.startsWith(starts), out);
    assert.equal(out.split('\n').length, text.split('\n').length);
    assert.ok(out.includes('"cupel-ran-x-1 "+globalThis.process.pid'), out);
    assert.equal(ts.createSourceFile('x.tsx', out, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX).parseDiagnostics.length, 0);
  }
  assert.deepEqual([...pidsAfter('12\nmark 34\n', 0)], ['12', '34']);
  assert.deepEqual([...pidsAfter('12\nmark 34\n', 3)], ['34']);
});

for (const loader of ['async', 'sync']) {
  test(`${loader} loader: loaded JSX with a source map is measured; without a map or unloaded it is listed apart`, { skip: noTypeScript }, async () => {
    const root = project();
    try {
      const logs = [];
      const input = await collectNode({ root, config: configFor(root, loader), runs: 2, strict: true, log: (s) => logs.push(s) });
      assert.deepEqual(validate(inputSchema, input), []);
      assert.deepEqual(integrityDiagnostics(input), []);
      const ts = projectTypeScript(root);
      assert.equal(input.sources['src/view.tsx'].coverable, formatLines(scanJsx(ts, 'src/view.tsx', VIEW).analysis.coverable));
      assert.equal(input.sources['src/view.tsx'].unmeasured, undefined);
      assert.equal(input.sources['src/badge.jsx'].coverable, '1-3');
      assert.equal(input.sources['src/nomap.jsx'].coverable, '');
      assert.equal(input.sources['src/nomap.jsx'].unmeasured, `${JSX_NO_MAP}: evaluated script has no inline source map`);
      assert.equal(input.sources['src/idle.tsx'].coverable, '');
      assert.equal(input.sources['src/idle.tsx'].unmeasured, JSX_NOT_LOADED);
      assert.match(input.sources['src/idle.tsx'].hash, /^sha256:/);
      const byTest = input.coverage.byTest;
      // label(2) takes the first return (line 3) and never the second (line 4); unused() is never called (line 10).
      assert.deepEqual(byTest['tests/view.test.mjs::many'], { 'src/view.tsx': '2-3,5' });
      assert.deepEqual(byTest['tests/view.test.mjs::view'], { 'src/view.tsx': '1-3,5-8' });
      assert.deepEqual(byTest['tests/view.test.mjs::badge'], { 'src/badge.jsx': '1-3' });
      assert.deepEqual(byTest['tests/view.test.mjs::price'], { 'src/price.mjs': '1-3' });
      for (const lines of Object.values(byTest)) assert.equal(lines['src/nomap.jsx'], undefined);
      // TypeScript's maps give the newline after a closing brace to the code that follows (K1: segment granularity).
      assert.deepEqual(input.coverage.setup['tests/view.test.mjs']['src/view.tsx'], '1-2,5-6,8-9,11');
      assert.equal(input.coverage.setup['tests/view.test.mjs']['src/nomap.jsx'], undefined);
      assert.deepEqual(input.coverage.unstable, {});
      assert.ok(logs.some((l) => l.includes('2 JSX sources measured through the project\'s loader')), logs.join('\n'));
      assert.ok(logs.some((l) => l.includes('src/nomap.jsx (JSX loaded without a usable source map')), logs.join('\n'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('re-checks map loaded JSX too', { skip: noTypeScript }, async () => {
  const root = project();
  try {
    const input = await collectNode({ root, config: configFor(root), runs: 1, strict: true, recheck: ['tests/view.test.mjs::many'] });
    assert.deepEqual(input.coverage.rechecked, ['tests/view.test.mjs::many']);
    assert.deepEqual(input.coverage.byTest['tests/view.test.mjs::many'], { 'src/view.tsx': '2-3,5' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without a loader JSX is not loaded, and the tests that import it fail', { skip: noTypeScript }, async () => {
  const root = project();
  try {
    const input = await collectNode({ root, config: {}, runs: 1 });
    for (const file of ['src/view.tsx', 'src/badge.jsx', 'src/nomap.jsx', 'src/idle.tsx']) assert.equal(input.sources[file].unmeasured, JSX_NOT_LOADED, file);
    assert.deepEqual(validate(inputSchema, input), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Runs the fixture's tests on a copy of the project whose file holds the mutant: the full run that must agree. */
function fullRun(root, source, text, loader) {
  const copy = mkdtempSync(join(repo, '.scratch/jsx-loader-full-'));
  try {
    cpSync(root, copy, { recursive: true, verbatimSymlinks: true, filter: (from) => !from.slice(root.length).includes('/.scratch') });
    writeFileSync(join(copy, source), text);
    const r = spawnSync(process.execPath, ['--test', 'tests/view.test.mjs'], {
      cwd: copy, encoding: 'utf8', env: plainEnv({ NODE_OPTIONS: `--import=${pathToFileURL(join(copy, 'loader/register.mjs')).href}`, FIXTURE_LOADER: loader }),
    });
    return r.status === 0 ? 'survived' : 'killed';
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

for (const loader of ['async', 'sync']) {
  test(`${loader} loader: JSX faults run through the loader, and a full run agrees with every status`, { skip: noTypeScript }, async () => {
    const root = project();
    try {
      const config = configFor(root, loader);
      const input = await collectNode({ root, config, runs: 1, strict: true });
      assert.deepEqual(input.tests.map((t) => t.status), ['passed', 'passed', 'passed', 'passed']);
      const logs = [];
      const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/view.tsx': '', 'src/badge.jsx': '' } }, log: (s) => logs.push(s), jobs: 2 });
      const statuses = new Map(mutation.mutants.map((m) => [m.id, m.status]));
      assert.ok([...statuses.values()].includes('killed'), logs.join('\n'));
      assert.ok([...statuses.values()].includes('survived'), logs.join('\n'));
      assert.ok(![...statuses.values()].includes('error'), logs.join('\n'));
      const boundary = mutation.mutants.find((m) => m.source === 'src/view.tsx' && m.line === 3 && m.operator === 'boundary');
      assert.equal(boundary?.status, 'survived', 'n >= 1 still gives "many" for 2');
      const ts = projectTypeScript(root);
      for (const source of ['src/view.tsx', 'src/badge.jsx']) {
        const text = readFileSync(join(root, source), 'utf8');
        for (const m of sourceMutants(root, source, text, ts)) {
          const status = statuses.get(m.id);
          if (status !== 'killed' && status !== 'survived') continue;
          assert.equal(fullRun(root, source, applyMutant(text, m), loader), status, `${m.id} (${m.operator} on line ${m.line})`);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('a loader that ignores the text it is handed never runs the fault: refused, never scored', { skip: noTypeScript }, async () => {
  const root = project();
  try {
    const input = await collectNode({ root, config: configFor(root, 'async'), runs: 1, strict: true });
    assert.equal(input.sources['src/view.tsx'].unmeasured, undefined);
    const logs = [];
    const mutation = await mutateNode({ root, config: configFor(root, 'own-read'), input, scope: { changed: { 'src/view.tsx': '' } }, log: (s) => logs.push(s), jobs: 2 });
    const ran = mutation.mutants.filter((m) => m.status !== 'no-coverage');
    assert.ok(ran.length > 0);
    for (const m of ran) assert.equal(m.status, 'error', `${m.id}: ${m.status}`);
    assert.ok(logs.some((l) => l.includes('was loaded but never ran')), logs.join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('end to end with tsx: JSX measured and its faults scored as a full run would', { skip: noTsx }, async () => {
  const files = Object.fromEntries(Object.entries(FILES).filter(([f]) => !f.startsWith('loader/')));
  files['tsconfig.json'] = '{"compilerOptions":{"jsx":"react","jsxFactory":"h","allowJs":true}}\n';
  const root = project(files, { tsx: join(TSX_MODULES, 'tsx'), typescript: join(TSX_MODULES, 'typescript') });
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: { NODE_OPTIONS: '--import tsx' } } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.deepEqual(input.tests.map((t) => t.status), ['passed', 'passed', 'passed', 'passed']);
    assert.equal(input.sources['src/view.tsx'].unmeasured, undefined);
    assert.equal(input.sources['src/idle.tsx'].unmeasured, JSX_NOT_LOADED);
    assert.deepEqual(input.coverage.byTest['tests/view.test.mjs::many'], { 'src/view.tsx': '2-3,5' });
    // esbuild's maps lead back to the file, so nomap.jsx is measured under tsx.
    assert.equal(input.sources['src/nomap.jsx'].unmeasured, undefined);
    if (HOOK_BUG) {
      // tsx imports esbuild (CommonJS) under Cupel's hooks: the unmutated run fails, so nothing is scored.
      await assert.rejects(mutateNode({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, jobs: 2 }), /fixed in Node 22\.23/);
      return;
    }
    const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, jobs: 2 });
    const statuses = new Map(mutation.mutants.map((m) => [m.id, m.status]));
    assert.ok([...statuses.values()].includes('killed'));
    assert.ok([...statuses.values()].includes('survived'));
    const text = readFileSync(join(root, 'src/view.tsx'), 'utf8');
    for (const m of sourceMutants(root, 'src/view.tsx', text, projectTypeScript(root))) {
      const status = statuses.get(m.id);
      if (status !== 'killed' && status !== 'survived') continue;
      const copy = mkdtempSync(join(repo, '.scratch/jsx-tsx-full-'));
      try {
        cpSync(root, copy, { recursive: true, verbatimSymlinks: true, filter: (from) => !from.slice(root.length).includes('/.scratch') });
        writeFileSync(join(copy, 'src/view.tsx'), applyMutant(text, m));
        const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/view.test.mjs'], { cwd: copy, encoding: 'utf8', env: plainEnv({}) });
        assert.equal(r.status === 0 ? 'survived' : 'killed', status, `${m.id}: ${r.stdout.slice(-1500)}${r.stderr.slice(-1500)}`);
      } finally { rmSync(copy, { recursive: true, force: true }); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a loader that breaks CommonJS imports under the mutant hooks breaks the unmutated run too: never a catch', async () => {
  // Any project loader on module.register (here a pass-through) with a test importing a CommonJS package. On Node 22
  // before 22.23 every run under the mutant hooks fails at that import; the baseline now runs under the same hooks.
  const root = project({
    'package.json': '{"private":true,"type":"module"}\n',
    'loader/register.mjs': "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n",
    'loader/hooks.mjs': 'export async function load(url, context, nextLoad) { return nextLoad(url, context); }\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { two } from 'cjsdep';\nimport { label } from '../src/label.mjs';\ntest('many', () => { assert.equal(label(two), 'many'); });\n",
    'node_modules/cjsdep/package.json': '{"name":"cjsdep","main":"index.js"}\n',
    'node_modules/cjsdep/index.js': 'exports.two = 2;\n',
  }, {});
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: { NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'loader/register.mjs')).href}` } } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.equal(input.tests[0].status, 'passed');
    const run = mutateNode({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, jobs: 2 });
    if (HOOK_BUG) return void await assert.rejects(run, /the unmutated run of tests\/label\.test\.mjs did not complete.*fixed in Node 22\.23/);
    const mutation = await run;
    const boundary = mutation.mutants.find((m) => m.line === 2 && m.operator === 'boundary');
    assert.equal(boundary.status, 'survived', 'n >= 1 still gives "many" for 2');
    assert.ok(mutation.mutants.some((m) => m.status === 'killed'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a CommonJS require hook (the @babel/register style): JSX measured, faults run through it and agree with a full run', { skip: noTypeScript }, async () => {
  const view = `${VIEW.replace(/^export /gm, '')}module.exports = { label, View, unused };\n`;
  const root = project({
    'package.json': '{"private":true}\n',
    // Wraps module._compile for .tsx, as pirates does, and transforms the text the loader read.
    'register.cjs': `const Module = require('node:module');
const ts = require('typescript');
Module._extensions['.tsx'] = function (mod, filename) {
  const compile = mod._compile;
  mod._compile = function (code) {
    mod._compile = compile;
    const out = ts.transpileModule(code, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', inlineSourceMap: true, inlineSources: true } }).outputText;
    return compile.call(this, out, filename);
  };
  return Module._extensions['.js'](mod, filename);
};
`,
    'src/view.tsx': view,
    'tests/view.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { View, label } = require('../src/view.tsx');\ntest('many', () => { assert.equal(label(2), 'many'); });\ntest('view', () => { assert.equal(View({ n: 2 }).children[0], 'many'); });\n",
  });
  try {
    const register = join(root, 'register.cjs');
    const config = { runners: { node: { tests: 'tests/**/*.test.cjs', env: { NODE_OPTIONS: `--require ${register}` } } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.deepEqual(input.coverage.byTest['tests/view.test.cjs::many'], { 'src/view.tsx': '2-3,5' });
    const run = mutateNode({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, jobs: 2 });
    // The require hook needs no async hook, but Cupel's own JSX hook is one: old Node 22 then breaks CommonJS.
    if (HOOK_BUG) return void await assert.rejects(run, /fixed in Node 22\.23/);
    const statuses = new Map((await run).mutants.map((m) => [m.id, m.status]));
    assert.ok([...statuses.values()].includes('killed') && [...statuses.values()].includes('survived'));
    for (const m of sourceMutants(root, 'src/view.tsx', view, projectTypeScript(root))) {
      const status = statuses.get(m.id);
      if (status !== 'killed' && status !== 'survived') continue;
      const copy = mkdtempSync(join(repo, '.scratch/jsx-cjs-full-'));
      try {
        cpSync(root, copy, { recursive: true, verbatimSymlinks: true, filter: (from) => !from.slice(root.length).includes('/.scratch') });
        writeFileSync(join(copy, 'src/view.tsx'), applyMutant(view, m));
        const r = spawnSync(process.execPath, ['--require', join(copy, 'register.cjs'), '--test', 'tests/view.test.cjs'], { cwd: copy, encoding: 'utf8', env: plainEnv({}) });
        assert.equal(r.status === 0 ? 'survived' : 'killed', status, m.id);
      } finally { rmSync(copy, { recursive: true, force: true }); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shards that load different JSX merge: measured beats not loaded; an unusable map beats measured and drops its lines', { skip: noTypeScript }, async () => {
  const root = project({
    ...FILES,
    // Shard 1 runs a.test.mjs (loads view.tsx); shard 2 runs b.test.mjs (loads only badge.jsx).
    'tests/view.test.mjs': undefined,
    'tests/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/view.tsx';\ntest('many', () => { assert.equal(label(2), 'many'); });\n",
    'tests/b.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { Badge } from '../src/badge.jsx';\ntest('badge', () => { assert.equal(Badge({ text: 'ok' }).children[0], 'OK'); });\n",
  });
  try {
    const config = configFor(root);
    const shards = [];
    for (const index of [1, 2]) shards.push({ file: `shard-${index}.json`, input: await collectNode({ root, config, runs: 1, strict: true, shard: { index, total: 2 } }) });
    assert.equal(shards[0].input.sources['src/badge.jsx'].unmeasured, JSX_NOT_LOADED);
    assert.equal(shards[1].input.sources['src/view.tsx'].unmeasured, JSX_NOT_LOADED);
    const merged = mergeInputs(shards);
    assert.equal(merged.sources['src/view.tsx'].unmeasured, undefined);
    assert.equal(merged.sources['src/badge.jsx'].coverable, '1-3');
    assert.equal(merged.sources['src/idle.tsx'].unmeasured, JSX_NOT_LOADED);
    assert.deepEqual(merged.coverage.byTest['tests/a.test.mjs::many'], { 'src/view.tsx': '2-3,5' });
    assert.deepEqual(integrityDiagnostics(merged), []);
    // A shard that loaded view.tsx without a usable map makes it unmeasured for all, and the other shard's lines go.
    const noMap = structuredClone(shards[1]);
    noMap.input.sources['src/view.tsx'] = { ...noMap.input.sources['src/view.tsx'], unmeasured: `${JSX_NO_MAP}: evaluated script has no inline source map` };
    const conservative = mergeInputs([shards[0], noMap]);
    assert.match(conservative.sources['src/view.tsx'].unmeasured, /^JSX loaded without a usable source map/);
    assert.deepEqual(conservative.coverage.byTest['tests/a.test.mjs::many'], {});
    assert.deepEqual(integrityDiagnostics(conservative), []);
    // Anything else that differs still refuses the merge.
    const changed = structuredClone(shards[1]);
    changed.input.sources['src/price.mjs'].coverable = '1';
    assert.throws(() => mergeInputs([shards[0], changed]), /differ in sources: src\/price\.mjs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
