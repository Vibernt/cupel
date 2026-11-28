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
import { hookBugs } from '../src/mutate/runner.mjs';
import { applyMutant } from '../src/mutate/operators.mjs';
import { sourceMutants } from '../src/mutate/sites.mjs';
import { eventsAfter, markedSource } from '../src/mutate/jsx-mark.mjs';
import { projectTypeScript, scanJsx } from '../src/lang/js/project-typescript.mjs';
import { formatLines } from '../src/collect/node/lines.mjs';
import { validate } from '../src/engine/schema.mjs';
import { integrityDiagnostics } from '../src/engine/integrity.mjs';
import { VITEST4_TYPESCRIPT } from './support/vitest-paths.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const inputSchema = JSON.parse(readFileSync(new URL('../../../spec/schemas/input.schema.json', import.meta.url), 'utf8'));
// This Node's module-hook bugs, probed as the runner probes them: with a bug a setup triggers, fault testing is refused.
mkdirSync(join(repo, '.scratch'), { recursive: true });
const PROBE = mkdtempSync(join(repo, '.scratch/jsx-probe-'));
const BUGS = hookBugs(PROBE);
rmSync(PROBE, { recursive: true, force: true });
const REFUSED = /fault testing is refused/;
const TSX_MODULES = process.env.CUPEL_TEST_TSX;
const TYPESCRIPT = process.env.CUPEL_TEST_TYPESCRIPT ??
  (TSX_MODULES && existsSync(join(TSX_MODULES, 'typescript/package.json')) ? join(TSX_MODULES, 'typescript') : VITEST4_TYPESCRIPT);
const noTypeScript = existsSync(join(TYPESCRIPT, 'package.json')) ? false : `no TypeScript at ${TYPESCRIPT} (set CUPEL_TEST_TYPESCRIPT)`;
const noTsx = TSX_MODULES && existsSync(join(TSX_MODULES, 'tsx/package.json')) && existsSync(join(TSX_MODULES, 'typescript/package.json'))
  ? false : 'set CUPEL_TEST_TSX to a node_modules folder with tsx and typescript';

// The loader: JSX and TypeScript through typescript's transpileModule, with an inline map unless the file name says
// `nomap`. FIXTURE_LOADER=sync uses registerHooks; =own-read reads the file itself instead of the text it is handed;
// =tsx-like adds, as tsx does, a CommonJS handler for .tsx that reads the file itself.
const LOADER = {
  'loader/transform.mjs': `import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ts = createRequire(import.meta.url)('typescript');
export const isJsx = (url) => /\\.(?:[jt]sx|ts)$/.test(url.split('?')[0]);
export function transform(url, source, kind = 'esm') {
  const fileName = fileURLToPath(url);
  const map = !fileName.includes('nomap');
  return ts.transpileModule(source, { fileName, compilerOptions: { module: kind === 'cjs' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
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
  'loader/register.mjs': `import Module, { register, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isJsx, text, transform } from './transform.mjs';
if (process.env.FIXTURE_LOADER === 'tsx-like') {
  Module._extensions['.tsx'] = function (mod, filename) {
    mod._compile(transform(pathToFileURL(filename).href, readFileSync(filename, 'utf8'), 'cjs'), filename);
  };
}
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

const ANY_BUG = BUGS.asyncCjs || BUGS.unknownExtension;

/** Fault testing with a loader or preload in play: refused (null) where Node has a module-hook bug, else run. */
async function mutateWithLoader(args) {
  if (!ANY_BUG) return mutateNode(args);
  await assert.rejects(mutateNode(args), REFUSED);
  return null;
}

/** Fault testing with a loader whose kind the test does not fix (tsx): refused only where Node has a hook bug. */
async function mutateMaybeRefused(args) {
  try { return await mutateNode(args); }
  catch (error) { if ((BUGS.asyncCjs || BUGS.unknownExtension) && REFUSED.test(error.message)) return null; throw error; }
}

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
  const events = eventsAfter('L 12\nL 12\nmark 12\nU 34\n', 0);
  assert.deepEqual([...events.get('L')], [['12', 2]]);
  assert.deepEqual([...events.get('mark')], [['12', 1]]);
  assert.deepEqual([...eventsAfter('L 12\nU 34\n', 5).keys()], ['U']);
  // Plain JavaScript and TypeScript without the project's typescript: the shared lexer finds the place.
  assert.equal(markedSource(null, 'a.mjs', "'use strict';\nexport const a = 1;\n", opts).startsWith("'use strict';try{"), true);
  assert.equal(markedSource(null, 'a.ts', '// c\nexport const a: number = 1;\n', opts).startsWith('// c\ntry{'), true);
  assert.equal(markedSource(null, 'a.cjs', '"use strict"\nmodule.exports = 1;\n', opts).startsWith('"use strict";try{'), true);
  assert.equal(markedSource(null, 'a.mjs', "'x'.length;\n", opts).startsWith("try{"), true);
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
      const mutation = await mutateWithLoader({ root, config, input, scope: { changed: { 'src/view.tsx': '', 'src/badge.jsx': '' } }, log: (s) => logs.push(s), jobs: 2 });
      if (!mutation) return;
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
    const mutation = await mutateWithLoader({ root, config: configFor(root, 'own-read'), input, scope: { changed: { 'src/view.tsx': '' } }, log: (s) => logs.push(s), jobs: 2 });
    if (!mutation) return;
    const ran = mutation.mutants.filter((m) => m.status !== 'no-coverage');
    assert.ok(ran.length > 0);
    for (const m of ran) assert.equal(m.status, 'error', `${m.id}: ${m.status}`);
    assert.ok(logs.some((l) => l.includes('was loaded but never shown to run')), logs.join('\n'));
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
    // Where Node has a module-hook bug tsx runs into (tsx imports esbuild, CommonJS), nothing is scored.
    const mutation = await mutateMaybeRefused({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, jobs: 2 });
    if (!mutation) return;
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
    if (BUGS.asyncCjs) return void await assert.rejects(run, /the unmutated run of tests\/label\.test\.mjs failed\).*fault testing is refused/);
    const mutation = await run;
    const boundary = mutation.mutants.find((m) => m.line === 2 && m.operator === 'boundary');
    assert.equal(boundary.status, 'survived', 'n >= 1 still gives "many" for 2');
    assert.ok(mutation.mutants.some((m) => m.status === 'killed'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// CUPEL_TEST_PIRATES names a pirates package folder (the require hook @babel/register and @swc-node/register use for
// CommonJS) for a run with the real hook in place of the hand-written one.
const PIRATES = process.env.CUPEL_TEST_PIRATES;
const noPirates = PIRATES && existsSync(join(PIRATES, 'package.json')) ? false : 'set CUPEL_TEST_PIRATES to a pirates package folder';
const TRANSPILE_CJS = `(code, filename) => ts.transpileModule(code, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', inlineSourceMap: true, inlineSources: true } }).outputText`;
const REQUIRE_HOOKS = {
  // Wraps module._compile for .tsx, as pirates does, and transforms the text the loader read.
  'hand-written': `const Module = require('node:module');
const ts = require('typescript');
const transpile = ${TRANSPILE_CJS};
Module._extensions['.tsx'] = function (mod, filename) {
  const compile = mod._compile;
  mod._compile = function (code) {
    mod._compile = compile;
    return compile.call(this, transpile(code, filename), filename);
  };
  return Module._extensions['.js'](mod, filename);
};
`,
  pirates: `const ts = require('typescript');
require('pirates').addHook(${TRANSPILE_CJS}, { exts: ['.tsx'] });
`,
};

for (const [kind, hook] of Object.entries(REQUIRE_HOOKS)) test(`a CommonJS require hook (${kind}, the @babel/register style): JSX measured, faults run through it and agree with a full run`, { skip: noTypeScript || (kind === 'pirates' && noPirates) }, async () => {
  const view = `${VIEW.replace(/^export /gm, '')}module.exports = { label, View, unused };\n`;
  const root = project({
    'package.json': '{"private":true}\n',
    'register.cjs': hook,
    'src/view.tsx': view,
    'tests/view.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { View, label } = require('../src/view.tsx');\ntest('many', () => { assert.equal(label(2), 'many'); });\ntest('view', () => { assert.equal(View({ n: 2 }).children[0], 'many'); });\n",
  }, kind === 'pirates' ? { typescript: TYPESCRIPT, pirates: PIRATES } : undefined);
  try {
    const register = join(root, 'register.cjs');
    const config = { runners: { node: { tests: 'tests/**/*.test.cjs', env: { NODE_OPTIONS: `--require ${register}` } } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.deepEqual(input.coverage.byTest['tests/view.test.cjs::many'], { 'src/view.tsx': '2-3,5' });
    const run = mutateNode({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, jobs: 2 });
    // Where Node has a module-hook bug, a loader or preload in play stops fault testing.
    if (ANY_BUG) return void await assert.rejects(run, REFUSED);
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

// Review findings on fd3b446. Every killed or survived fault is checked against a full run of the mutated file.

/** The project's tests on a copy whose `source` holds `text`: 'killed' when they fail, else 'survived'. */
function fullRunOf(root, source, text, args, env) {
  const copy = mkdtempSync(join(repo, '.scratch/jsx-review-full-'));
  try {
    cpSync(root, copy, { recursive: true, verbatimSymlinks: true, filter: (from) => !from.slice(root.length).includes('/.scratch') });
    writeFileSync(join(copy, source), text);
    const r = spawnSync(process.execPath, args, { cwd: copy, encoding: 'utf8', env: plainEnv(env(copy)) });
    return r.status === 0 ? 'survived' : 'killed';
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

/** Asserts no fault is scored differently from a full run; returns the statuses by id. */
function agreeWithFullRuns(root, mutation, args, env) {
  const statuses = new Map(mutation.mutants.map((m) => [m.id, m.status]));
  const ts = projectTypeScript(root);
  for (const source of new Set(mutation.mutants.map((m) => m.source))) {
    const text = readFileSync(join(root, source), 'utf8');
    for (const m of sourceMutants(root, source, text, ts)) {
      const status = statuses.get(m.id);
      if (status !== 'killed' && status !== 'survived') continue;
      assert.equal(fullRunOf(root, source, applyMutant(text, m), args, env), status, `${m.id} (${m.operator} on line ${m.line})`);
    }
  }
  return statuses;
}

const loaderEnv = (loader) => (dir) => ({ NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'loader/register.mjs')).href}`, FIXTURE_LOADER: loader });
const LABEL_TSX = "const h = (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props, children });\nexport function label(n: number): string {\n  if (n > 1) return 'many';\n  return 'one';\n}\nexport const View = ({ n }: { n: number }) => <p>{label(n)}</p>;\n";

for (const layout of ['two files', 'one process']) {
  test(`finding 1 (${layout}): a loader that reads the file itself for require() never gets a fault scored`, { skip: noTypeScript || (ANY_BUG && 'this Node refuses fault testing with a loader') }, async () => {
    // ESM import goes through the hooks; tsx-like require() reads view.tsx from disk and runs the original.
    const tests = layout === 'two files' ? {
      'tests/a.test.mjs': "import test from 'node:test';\nimport { label } from '../src/view.tsx';\ntest('a', () => { label(2); label(1); });\n",
      'tests/b.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { label } = require('../src/view.tsx');\ntest('b', () => { assert.equal(label(2), 'many'); assert.equal(label(1), 'one'); });\n",
    } : {
      'tests/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nimport { label } from '../src/view.tsx';\nconst cjs = createRequire(import.meta.url)('../src/view.tsx');\ntest('a', () => { label(2); assert.equal(cjs.label(2), 'many'); assert.equal(cjs.label(1), 'one'); });\n",
    };
    const root = project({ ...LOADER, 'package.json': '{"private":true,"type":"module"}\n', 'src/view.tsx': LABEL_TSX, ...tests });
    try {
      const config = { runners: { node: { tests: 'tests/**/*.test.*', env: loaderEnv('tsx-like')(root) } } };
      const input = await collectNode({ root, config, runs: 1, strict: true });
      assert.equal(input.sources['src/view.tsx'].unmeasured, undefined);
      const logs = [];
      const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, log: (s) => logs.push(s), jobs: 2 });
      const statuses = agreeWithFullRuns(root, mutation, ['--test', ...Object.keys(tests)], loaderEnv('tsx-like'));
      assert.ok([...statuses.values()].includes('error'), logs.join('\n'));
      assert.ok(![...statuses.values()].includes('survived'), 'the full run kills every fault on line 3');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('finding 1 with tsx: ESM import plus CommonJS require never scores a fault the full run disagrees with', { skip: noTsx }, async () => {
  const root = project({
    'package.json': '{"private":true,"type":"module"}\n', 'tsconfig.json': '{"compilerOptions":{"jsx":"react","jsxFactory":"h"}}\n',
    'src/view.tsx': LABEL_TSX,
    'tests/a.test.mjs': "import test from 'node:test';\nimport { label } from '../src/view.tsx';\ntest('a', () => { label(2); label(1); });\n",
    'tests/b.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { label } = require('../src/view.tsx');\ntest('b', () => { assert.equal(label(2), 'many'); assert.equal(label(1), 'one'); });\n",
  }, { tsx: join(TSX_MODULES, 'tsx'), typescript: join(TSX_MODULES, 'typescript') });
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.*', env: { NODE_OPTIONS: '--import tsx' } } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const mutation = await mutateMaybeRefused({ root, config, input, scope: { changed: { 'src/view.tsx': '' } }, jobs: 2 });
    if (!mutation) return;
    const statuses = agreeWithFullRuns(root, mutation, ['--import', 'tsx', '--test', 'tests/a.test.mjs', 'tests/b.test.cjs'], () => ({}));
    assert.ok(![...statuses.values()].includes('survived'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finding 2: on Node 22 before 22.23 a loader refuses fault testing even when only a test body breaks', async () => {
  const root = project({
    'package.json': '{"private":true,"type":"module"}\n',
    'loader/register.mjs': "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n",
    'loader/hooks.mjs': 'export async function load(url, context, nextLoad) { return nextLoad(url, context); }\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/label.mjs';\ntest('smoke', () => { label(2); });\ntest('many', async () => { const { two } = await import('cjsdep'); assert.equal(label(two), 'many'); assert.equal(label(1), 'one'); });\n",
    'node_modules/cjsdep/package.json': '{"name":"cjsdep","main":"index.js"}\n',
    'node_modules/cjsdep/index.js': 'exports.two = 2;\n',
  }, {});
  try {
    const env = (dir) => ({ NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'loader/register.mjs')).href}` });
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: env(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const run = mutateNode({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, jobs: 2 });
    if (BUGS.asyncCjs) return void await assert.rejects(run, /CommonJS imports while sync and async module hooks are both registered.*fault testing is refused/);
    const statuses = agreeWithFullRuns(root, await run, ['--test', 'tests/label.test.mjs'], env);
    assert.equal([...statuses.values()].filter((s) => s === 'killed').length, statuses.size, 'label(1) and label(2) both asserted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findings 3 and 4: without a project loader no async hook and no warning reach the tests, even with --throw-deprecation', async () => {
  const root = project({
    'package.json': '{"private":true,"type":"module"}\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    // A child's stderr must stay empty, as it is outside Cupel.
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\nimport { label } from '../src/label.mjs';\ntest('quiet', () => { assert.equal(spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' }).stderr, ''); assert.equal(label(2), 'many'); assert.equal(label(1), 'one'); });\n",
  }, {});
  try {
    const env = () => ({ NODE_OPTIONS: '--throw-deprecation' });
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: env() } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    // As a runner merge gives the node part: a JSX source another runner measured, which node's tests never load.
    input.sources['src/App.tsx'] = { coverable: '1-3', hash: `sha256:${'0'.repeat(64)}` };
    const logs = [];
    const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, log: (s) => logs.push(s), jobs: 2 });
    assert.ok(!logs.some((l) => l.includes('fails unmutated')), logs.join('\n'));
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], env);
    assert.equal([...statuses.values()].filter((s) => s === 'killed').length, statuses.size);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finding 5: JSX only a child process may load is not "not loaded", so a runner merge refuses it; its re-check keeps shared coverage', { skip: noTypeScript }, async () => {
  const { mergeRunners } = await import('../src/cli/merge-runners.mjs');
  const { JSX_IN_CHILD } = await import('../src/collect/node/index.mjs');
  const root = project({
    ...LOADER, 'package.json': '{"private":true,"type":"module"}\n', 'src/view.tsx': LABEL_TSX,
    'tests/child.mjs': "import { label } from '../src/view.tsx';\nif (label(2) !== 'many') process.exit(1);\n",
    'tests/view.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\ntest('child', () => { assert.equal(spawnSync(process.execPath, [fileURLToPath(new URL('./child.mjs', import.meta.url))]).status, 0); });\n",
  });
  try {
    const config = configFor(root);
    const logs = [];
    const input = await collectNode({ root, config, runs: 1, strict: true, recheck: ['tests/view.test.mjs::child'], log: (s) => logs.push(s) });
    assert.equal(input.sources['src/view.tsx'].unmeasured, JSX_IN_CHILD);
    assert.equal(input.coverage.rechecked, undefined);
    assert.ok(logs.some((l) => l.includes('ran JSX or transformed code in a child process')), logs.join('\n'));
    const vitest = { ...structuredClone(input), sources: { ...input.sources, 'src/view.tsx': { coverable: '1-6', hash: input.sources['src/view.tsx'].hash } },
      tests: [{ id: 'tests/view.test.tsx::v', file: 'tests/view.test.tsx', name: 'v', status: 'passed' }], coverage: { granularity: 'test', byTest: {}, setup: {} } };
    assert.throws(() => mergeRunners([{ name: 'node', input }, { name: 'vitest', input: vitest }]), /runs it without measuring it \(JSX not loaded in any test process Cupel measures/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finding 7: TypeScript faults under an async loader run through it and agree with a full run', { skip: noTypeScript || (ANY_BUG && 'this Node refuses fault testing with a loader') }, async () => {
  const root = project({
    ...LOADER, 'package.json': '{"private":true,"type":"module"}\n',
    // An enum: Node's own type stripping cannot run it, so only the loader's output can.
    'src/label.ts': "enum K { A = 1 }\nexport function label(n: number): string {\n  if (n > K.A) return 'many';\n  return 'one';\n}\n",
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/label.ts';\ntest('many', () => { assert.equal(label(2), 'many'); });\n",
  });
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: loaderEnv('async')(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/label.ts': '' } }, jobs: 2 });
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], loaderEnv('async'));
    const boundary = mutation.mutants.find((m) => m.line === 3 && m.operator === 'boundary');
    assert.equal(boundary.status, 'survived', 'n >= 1 still gives "many" for 2');
    assert.ok([...statuses.values()].includes('killed'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('finding 8: the "no usable map" reason does not depend on the order processes finished', async () => {
  const { settleJsx } = await import('../src/collect/node/index.mjs');
  const pick = (failures) => {
    const unmeasured = new Map();
    settleJsx(new Map([['src/a.jsx', { hash: 'h', an: {}, problem: null }]]), new Map([['src/a.jsx', { loaded: true, failures, child: false }]]), new Map(), unmeasured, () => {});
    return unmeasured.get('src/a.jsx').reason;
  };
  const a = { url: 'file:///p/src/a.jsx', cause: 'evaluated script has no inline source map' };
  const b = { url: 'file:///p/src/a.jsx?v=2', cause: 'source map content differs from original' };
  assert.equal(pick([a, b]), pick([b, a]));
  assert.equal(pick([b, a]), `${JSX_NO_MAP}: ${a.cause}`);
});

test('finding 6: plain files --experimental-loader hooks pass through unchanged (as Yarn PnP does) are scored', { skip: noTypeScript }, async () => {
  const root = project({ ...LOADER, 'package.json': '{"private":true,"type":"module"}\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    'tests/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/label.mjs';\ntest('a', () => { assert.equal(label(2), 'many'); assert.equal(label(1), 'one'); });\n" });
  try {
    const flag = (dir) => ({ NODE_OPTIONS: `--experimental-loader=${pathToFileURL(join(dir, 'loader/hooks.mjs')).href}` });
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: flag(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const mutation = await mutateWithLoader({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, jobs: 2 });
    if (!mutation) return;
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/a.test.mjs'], flag);
    assert.equal([...statuses.values()].filter((x) => x === 'killed').length, statuses.size, [...statuses].join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Re-review of 4f08414.

for (const kind of ['register', 'registerHooks']) {
  test(`re-review 1: a loader a --require preload sets up with ${kind} sits below Cupel's hook: faults it changes are refused, never bypassed`, { skip: noTypeScript }, async () => {
    const reg = kind === 'register'
      ? "const { register } = require('node:module');\nconst { pathToFileURL } = require('node:url');\nregister('./hooks.mjs', pathToFileURL(__filename));\n"
      : "const { registerHooks } = require('node:module');\nimport('./transform.mjs').then(() => {});\nconst { transformSync } = require('./transform-sync.cjs');\nregisterHooks({ load(url, context, next) { if (!/\\.ts$/.test(url)) return next(url, context); const r = next(url, { ...context, format: 'module' }); return { format: 'module', source: transformSync(url, String(r.source)), shortCircuit: true }; } });\n";
    const root = project({ ...LOADER, 'package.json': '{"private":true,"type":"module"}\n', 'loader/reg.cjs': reg,
      'loader/transform-sync.cjs': "const ts = require('typescript');\nconst { fileURLToPath } = require('node:url');\nexports.transformSync = (url, source) => ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, inlineSourceMap: true, inlineSources: true } }).outputText;\n",
      'src/label.ts': LABEL_TS, 'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/label.ts';\ntest('many', () => { assert.equal(label(5), 'many'); assert.equal(label(1), 'one'); });\n" });
    try {
      const env = (dir) => ({ NODE_OPTIONS: `--require=${join(dir, 'loader/reg.cjs')}` });
      const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: env(root) } } };
      // Under --require, Node also runs the preload in the hooks thread, so an async loader registers twice and its
      // map no longer matches the file: collect that one through --import, where the map is clean.
      const input = await collectNode({ root, config: kind === 'register' ? { runners: { node: { tests: 'tests/**/*.test.mjs', env: loaderEnv('async')(root) } } } : config, runs: 1, strict: true });
      assert.deepEqual(input.coverage.byTest['tests/label.test.mjs::many'], { 'src/label.ts': '2-5' });
      const mutation = await mutateMaybeRefused({ root, config, input, scope: { changed: { 'src/label.ts': '' } }, jobs: 2 });
      if (!mutation) return;
      agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], env);
      for (const m of mutation.mutants.filter((x) => x.status !== 'no-coverage')) assert.equal(m.status, 'error', m.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('re-review 2: a preload that installs nothing, an unrelated require.extensions entry and a child with --import are scored where Node has no hook bug', async () => {
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'setup.mjs': 'globalThis.__setup = 1;\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nimport { spawnSync } from 'node:child_process';\nimport { label } from '../src/label.mjs';\ncreateRequire(import.meta.url).extensions['.css'] = () => {};\ntest('many', () => { assert.equal(globalThis.__setup, 1); assert.equal(spawnSync(process.execPath, ['--import', './setup.mjs', '-e', '0']).status, 0); assert.equal(label(2), 'many'); assert.equal(label(1), 'one'); });\n" }, {});
  try {
    const env = (dir) => ({ NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'setup.mjs')).href}` });
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: env(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    // On a Node with a module-hook bug any preload stops it (review 3: a test can hide the bug's failure).
    const mutation = await mutateWithLoader({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, jobs: 2 });
    if (!mutation) return;
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], env);
    assert.equal([...statuses.values()].filter((x) => x === 'killed').length, statuses.size);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-review 3: a fault only a child process of the test runs is proven by that child', async () => {
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'setup.mjs': 'globalThis.__setup = 1;\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    'src/cli.mjs': "import { label } from './label.mjs';\nconsole.log(label(Number(process.argv[2])));\n",
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { execFileSync } from 'node:child_process';\ntest('cli', () => { assert.equal(execFileSync(process.execPath, ['src/cli.mjs', '5'], { encoding: 'utf8' }).trim(), 'many'); assert.equal(execFileSync(process.execPath, ['src/cli.mjs', '1'], { encoding: 'utf8' }).trim(), 'one'); });\n" }, {});
  try {
    // A preload puts a loader in play, so every fault carries the run proof.
    const env = (dir) => ({ NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'setup.mjs')).href}` });
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: env(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true, recheck: ['tests/label.test.mjs::cli'] });
    assert.equal(input.coverage.byTest['tests/label.test.mjs::cli']['src/label.mjs'], '1-4');
    const mutation = await mutateWithLoader({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, jobs: 2 });
    if (!mutation) return;
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], env);
    assert.equal([...statuses.values()].filter((x) => x === 'killed').length, statuses.size, [...statuses].join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-review 4: a module imported and also required in one process runs once and is proven once', async () => {
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'setup.mjs': 'globalThis.__setup = 1;\n',
    'src/label.mjs': "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n",
    'tests/helper.cjs': "module.exports = require('../src/label.mjs').label;\n",
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nimport { label } from '../src/label.mjs';\nconst again = createRequire(import.meta.url)('./helper.cjs');\ntest('many', () => { assert.equal(label(2), 'many'); assert.equal(again(1), 'one'); });\n" }, {});
  try {
    const env = (dir) => ({ NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'setup.mjs')).href}` });
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs', env: env(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const mutation = await mutateWithLoader({ root, config, input, scope: { changed: { 'src/label.mjs': '' } }, jobs: 2 });
    if (!mutation) return;
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], env);
    assert.ok(![...statuses.values()].includes('error'), [...statuses].join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-review 5 / review 3 finding 4: a test that starts node processes leaves unloaded JSX conservative unless a re-check measured its children', async () => {
  const { JSX_IN_CHILD } = await import('../src/collect/node/index.mjs');
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'src/view.tsx': LABEL_TSX,
    'tests/a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\ntest('a', () => { assert.equal(spawnSync(process.execPath, ['-e', '0']).status, 0); });\n" }, {});
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs' } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.equal(input.tests[0].spawnsInterpreter, true);
    // The child could have had a loader of its own: not "not loaded".
    assert.equal(input.sources['src/view.tsx'].unmeasured, JSX_IN_CHILD);
    // A re-check measured that test's children, and they did not run the JSX.
    const rechecked = await collectNode({ root, config, runs: 1, strict: true, recheck: ['tests/a.test.mjs::a'] });
    assert.deepEqual(rechecked.coverage.rechecked, ['tests/a.test.mjs::a']);
    assert.equal(rechecked.sources['src/view.tsx'].unmeasured, JSX_NOT_LOADED);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review 3 finding 4: JSX a child runs with a loader of its own is never "not loaded"', { skip: noTypeScript }, async () => {
  const { JSX_IN_CHILD } = await import('../src/collect/node/index.mjs');
  const root = project({ ...LOADER, 'package.json': '{"private":true,"type":"module"}\n', 'src/cli.tsx': `${LABEL_TSX}console.log(label(Number(process.argv[2])));\n`,
    'tests/cli.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { execFileSync } from 'node:child_process';\nimport { pathToFileURL } from 'node:url';\nconst loader = pathToFileURL('loader/register.mjs').href;\ntest('cli', () => { assert.equal(execFileSync(process.execPath, ['--import', loader, 'src/cli.tsx', '5'], { encoding: 'utf8' }).trim(), 'many'); });\n" });
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs' } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.equal(input.tests[0].status, 'passed');
    assert.equal(input.sources['src/cli.tsx'].unmeasured, JSX_IN_CHILD);
    const rechecked = await collectNode({ root, config, runs: 1, strict: true, recheck: ['tests/cli.test.mjs::cli'] });
    assert.equal(rechecked.sources['src/cli.tsx'].unmeasured, JSX_IN_CHILD);
    assert.equal(rechecked.coverage.rechecked, undefined, 'its children ran JSX that cannot be mapped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Sources other than JSX that a loader transforms: mapped through the script's own source map, or unmeasured.

const LABEL_TS = "enum K { A = 1 }\nexport function label(n: number): string {\n  if (n > K.A) return 'many';\n  return 'one';\n}\n";
const LABEL_TEST = (file) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/${file}';\ntest('many', () => { assert.equal(label(2), 'many'); });\n`;

test('a .ts file a loader compiles is mapped through its map: the line the test never reaches is not covered', { skip: noTypeScript }, async () => {
  const { SOURCE_NO_MAP } = await import('../src/collect/node/index.mjs');
  const root = project({ ...LOADER, 'package.json': '{"private":true,"type":"module"}\n',
    'src/label.ts': LABEL_TS, 'src/nomap-label.ts': LABEL_TS,
    'tests/label.test.mjs': LABEL_TEST('label.ts'), 'tests/nomap.test.mjs': LABEL_TEST('nomap-label.ts') });
  try {
    const logs = [];
    const input = await collectNode({ root, config: configFor(root), runs: 2, strict: true, log: (s) => logs.push(s) });
    assert.deepEqual(validate(inputSchema, input), []);
    assert.deepEqual(integrityDiagnostics(input), []);
    // label(2): lines 2-3 run, line 4 (`return 'one'`) never does; TypeScript's map credits line 5's brace (K1).
    assert.deepEqual(input.coverage.byTest['tests/label.test.mjs::many'], { 'src/label.ts': '2-3,5' });
    assert.equal(input.sources['src/label.ts'].coverable, '1-5');
    // The same file through the same loader without a map: never guessed.
    assert.deepEqual(input.sources['src/nomap-label.ts'], { coverable: '', hash: input.sources['src/nomap-label.ts'].hash, unmeasured: `${SOURCE_NO_MAP}: evaluated script has no inline source map` });
    assert.deepEqual(input.coverage.byTest['tests/nomap.test.mjs::many'], {});
    assert.equal(input.coverage.setup['tests/nomap.test.mjs']?.['src/nomap-label.ts'], undefined);
    assert.ok(logs.some((l) => l.includes('1 source transformed by a loader, measured through its source map')), logs.join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('end to end with tsx: a .ts file tsx compiles is mapped, and its unreached line is not covered', { skip: noTsx }, async () => {
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'src/label.ts': LABEL_TS, 'tests/label.test.mjs': LABEL_TEST('label.ts') },
    { tsx: join(TSX_MODULES, 'tsx'), typescript: join(TSX_MODULES, 'typescript') });
  try {
    const input = await collectNode({ root, config: { runners: { node: { tests: 'tests/**/*.test.mjs', env: { NODE_OPTIONS: '--import tsx' } } } }, runs: 1, strict: true });
    assert.deepEqual(input.coverage.byTest['tests/label.test.mjs::many'], { 'src/label.ts': '2-3,5' });
    assert.equal(input.sources['src/label.ts'].unmeasured, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plain .mjs and Node-stripped .ts measure the same with and without a loader in play', { skip: noTypeScript }, async () => {
  const files = { 'package.json': '{"private":true,"type":"module"}\n',
    'src/price.mjs': 'export function price(amount, percent) {\n  if (percent > 0) return amount - (amount * percent) / 100;\n  return amount;\n}\n',
    'src/sum.ts': 'export function sum(a: number, b: number): number {\n  if (a < 0) return b;\n  return a + b;\n}\ninterface Unused { x: string }\n',
    'tests/plain.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { price } from '../src/price.mjs';\nimport { sum } from '../src/sum.ts';\ntest('p', () => { assert.equal(price(100, 10), 90); assert.equal(sum(1, 2), 3); });\n" };
  const root = project(files);
  try {
    const plain = await collectNode({ root, config: { runners: { node: { tests: 'tests/**/*.test.mjs' } } }, runs: 1, strict: true });
    // A preload puts a loader in play, so the hook reads every script's text: both still run at the file's offsets.
    const loaded = await collectNode({ root, config: { runners: { node: { tests: 'tests/**/*.test.mjs', env: { NODE_OPTIONS: '--import=data:text/javascript,0' } } } }, runs: 1, strict: true });
    assert.deepEqual(plain.coverage, loaded.coverage);
    assert.deepEqual(plain.sources, loaded.sources);
    assert.deepEqual(plain.coverage.byTest['tests/plain.test.mjs::p'], { 'src/price.mjs': '1-2,4', 'src/sum.ts': '1-4' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('K14 and shards: a source node:test runs through a loader but cannot map is refused beside a measuring runner, and wins a shard merge', { skip: noTypeScript }, async () => {
  const { mergeRunners } = await import('../src/cli/merge-runners.mjs');
  const root = project({ ...LOADER, 'package.json': '{"private":true,"type":"module"}\n', 'src/nomap-label.ts': LABEL_TS,
    'tests/a.test.mjs': LABEL_TEST('nomap-label.ts'), 'tests/b.test.mjs': "import test from 'node:test';\ntest('b', () => {});\n" });
  try {
    const config = configFor(root);
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const vitest = { ...structuredClone(input), sources: { 'src/nomap-label.ts': { coverable: '1-5', hash: input.sources['src/nomap-label.ts'].hash } },
      tests: [{ id: 'tests/label.test.ts::v', file: 'tests/label.test.ts', name: 'v', status: 'passed' }], coverage: { granularity: 'test', byTest: {}, setup: {} } };
    assert.throws(() => mergeRunners([{ name: 'node', input }, { name: 'vitest', input: vitest }]), /measures src\/nomap-label\.ts and another runs it without measuring it \(transformed by a loader without a usable source map/);
    // Shard 1 runs a.test.mjs (loads it, no map); shard 2 runs b.test.mjs (never loads it, so it looks measured).
    const shards = [];
    for (const index of [1, 2]) shards.push({ file: `shard-${index}.json`, input: await collectNode({ root, config, runs: 1, strict: true, shard: { index, total: 2 } }) });
    assert.match(shards[0].input.sources['src/nomap-label.ts'].unmeasured, /^transformed by a loader/);
    assert.equal(shards[1].input.sources['src/nomap-label.ts'].unmeasured, undefined);
    const merged = mergeInputs(shards);
    assert.match(merged.sources['src/nomap-label.ts'].unmeasured, /^transformed by a loader/);
    assert.deepEqual(integrityDiagnostics(merged), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same offsets: the file itself, or types blanked with lines kept and a sourceURL trailer', async () => {
  const { sameOffsets } = await import('../src/collect/node/same-offsets.mjs');
  const file = 'export function c(n: number): number {\n  return n;\n}\n';
  assert.equal(sameOffsets(file, file), true);
  assert.equal(sameOffsets('export function c(n        )         {\n  return n;\n}\n\n\n//# sourceURL=file:///p/c.ts', file), true);
  assert.equal(sameOffsets('export function c(n) {\n  return n;\n}\n', file), false, 'shorter: moved');
  assert.equal(sameOffsets('export function c(n        )        \n{\n  return n;\n}\n', file), false, 'a newline moved');
  assert.equal(sameOffsets(file.replace('return', 'RETURN'), file), false);
  assert.equal(sameOffsets(`${file}//# sourceMappingURL=data:application/json;base64,e30=`, file), false, 'a map means a loader made it');
});

// Review 3 (of 014e8e4).

const PLAIN = "export function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n}\n";
const LABEL_TESTS = (from) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '${from}';\ntest('many', () => { assert.equal(label(5), 'many'); });\ntest('one', () => { assert.equal(label(0), 'one'); });\n`;

for (const variant of ['extension', 'async']) {
  test(`review 3 finding 1 (${variant}): a hook bug a test hides in try/catch still refuses fault testing on a Node that has it`, async () => {
    const files = variant === 'extension' ? {
      'package.json': '{"private":true}\n',
      'register.cjs': "require('node:module')._extensions['.conf'] = (m, f) => m._compile('module.exports = ' + require('node:fs').readFileSync(f, 'utf8'), f);\n",
      'src/limit.conf': '{ "limit": 1 }\n',
      'src/label.cjs': "let limit;\ntry { limit = require('./limit.conf').limit; } catch { limit = 100; }\nexports.label = function label(n) {\n  if (n > limit) return 'many';\n  return 'one';\n};\n",
      'tests/label.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { label } = require('../src/label.cjs');\ntest('many', () => { assert.equal(label(5), 'many'); });\ntest('one', () => { assert.equal(label(0), 'one'); });\n",
    } : {
      'package.json': '{"private":true,"type":"module"}\n',
      'register.cjs': "const { register } = require('node:module');\nconst { pathToFileURL } = require('node:url');\nregister('./hooks.mjs', pathToFileURL(__filename));\n",
      'hooks.mjs': 'export async function load(url, context, next) { return next(url, context); }\n',
      'src/limit.cjs': 'module.exports = 1;\n',
      'src/label.mjs': "let limit = 100;\ntry { limit = (await import('./limit.cjs')).default; } catch {}\nexport function label(n) {\n  if (n > limit) return 'many';\n  return 'one';\n}\n",
      'tests/label.test.mjs': LABEL_TESTS('../src/label.mjs'),
    };
    const source = variant === 'extension' ? 'src/label.cjs' : 'src/label.mjs';
    const testFile = variant === 'extension' ? 'tests/label.test.cjs' : 'tests/label.test.mjs';
    const root = project(files, {});
    try {
      const env = (dir) => ({ NODE_OPTIONS: `--require=${join(dir, 'register.cjs')}` });
      const config = { runners: { node: { tests: 'tests/**/*.test.*', env: env(root) } } };
      const input = await collectNode({ root, config, runs: 1, strict: true });
      const mutation = await mutateWithLoader({ root, config, input, scope: { changed: { [source]: '' } }, jobs: 2 });
      if (!mutation) return;
      agreeWithFullRuns(root, mutation, ['--test', testFile], env);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('review 3 finding 2: a byte-order mark scores faults as before, with no loader (.mjs and .ts)', async () => {
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'src/label.mjs': `﻿${PLAIN}`,
    'src/kind.ts': '﻿export function kind(n: number): string {\n  if (n > 1) return \'many\';\n  return \'one\';\n}\n',
    'tests/label.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/label.mjs';\nimport { kind } from '../src/kind.ts';\ntest('many', () => { assert.equal(label(5), 'many'); assert.equal(kind(5), 'many'); });\ntest('one', () => { assert.equal(label(0), 'one'); assert.equal(kind(0), 'one'); });\n" }, {});
  try {
    const config = { runners: { node: { tests: 'tests/**/*.test.mjs' } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/label.mjs': '', 'src/kind.ts': '' } }, jobs: 2 });
    const statuses = agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.mjs'], () => ({}));
    assert.ok(![...statuses.values()].includes('error'), [...statuses].join('\n'));
    assert.ok([...statuses.values()].includes('killed'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review 3 finding 3: a byte-order mark keeps a source measured, identically, when a harmless preload is in play', async () => {
  const root = project({ 'package.json': '{"private":true,"type":"module"}\n', 'setup.mjs': 'globalThis.x = 1;\n', 'src/label.mjs': `﻿${PLAIN}`,
    'tests/label.test.mjs': LABEL_TESTS('../src/label.mjs') }, {});
  try {
    const plain = await collectNode({ root, config: { runners: { node: { tests: 'tests/**/*.test.mjs' } } }, runs: 1, strict: true });
    const preloaded = await collectNode({ root, config: { runners: { node: { tests: 'tests/**/*.test.mjs', env: { NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'setup.mjs')).href}` } } } }, runs: 1, strict: true });
    assert.equal(preloaded.sources['src/label.mjs'].unmeasured, undefined);
    assert.deepEqual(preloaded.sources, plain.sources);
    assert.deepEqual(preloaded.coverage, plain.coverage);
    assert.deepEqual(plain.coverage.byTest['tests/label.test.mjs::one'], { 'src/label.mjs': '1-4' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const how of ['extensions', 'wrap']) {
  test(`review 3 finding 5 (${how}): a CommonJS transform set up and undone before Cupel looks is still seen: lines are never guessed`, async () => {
    const { SOURCE_NO_MAP } = await import('../src/collect/node/index.mjs');
    const install = how === 'extensions'
      ? "const orig = Module._extensions['.js'];\nModule._extensions['.js'] = (m, f) => { if (!/[\\\\/]src[\\\\/]/.test(f)) return orig(m, f); m._compile('\"use strict\";\\nvar __a = 1;\\n' + require('node:fs').readFileSync(f, 'utf8'), f); };\nconst { label } = require('../src/label.js');\nModule._extensions['.js'] = orig;\n"
      : "const orig = Module.wrap;\nModule.wrap = (script) => orig('var __a = 1;\\n' + script);\nconst { label } = require('../src/label.js');\nModule.wrap = orig;\n";
    const root = project({ 'package.json': '{"private":true}\n',
      'src/label.js': "exports.label = function label(n) {\n  if (n > 1) {\n    return 'many';\n  }\n  return 'one';\n};\nexports.other = function other() {\n  return 2;\n};\n",
      'tests/label.test.cjs': `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst Module = require('node:module');\n${install}test('many', () => { assert.equal(label(5), 'many'); });\n` }, {});
    try {
      const input = await collectNode({ root, config: { runners: { node: { tests: 'tests/**/*.test.cjs' } } }, runs: 1, strict: true });
      assert.deepEqual(input.sources['src/label.js'], { coverable: '', hash: input.sources['src/label.js'].hash, unmeasured: `${SOURCE_NO_MAP}: evaluated script has no inline source map` });
      assert.deepEqual(input.coverage.byTest['tests/label.test.cjs::many'], {});
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('review 3 finding 6: a test process the input says ran the file must run the fault itself; a child cannot vouch for it', { skip: ANY_BUG && 'this Node refuses fault testing with a preload' }, async () => {
  const root = project({ 'package.json': '{"private":true}\n', 'setup.cjs': 'globalThis.x = 1;\n',
    'src/label.js': "globalThis.label = function label(n) {\n  if (n > 1) return 'many';\n  return 'one';\n};\n",
    // The test process evaluates the file's own text (vm), outside the module hooks; a child requires it.
    'tests/label.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst vm = require('node:vm');\nconst { readFileSync } = require('node:fs');\nconst { join } = require('node:path');\nconst { pathToFileURL } = require('node:url');\nconst { execFileSync } = require('node:child_process');\nconst file = join(__dirname, '../src/label.js');\nvm.runInThisContext(readFileSync(file, 'utf8'), { filename: pathToFileURL(file).href });\ntest('t', () => { assert.equal(globalThis.label(1), 'one'); assert.equal(execFileSync(process.execPath, ['-e', \"require('./src/label.js'); process.stdout.write(label(5))\"], { encoding: 'utf8' }), 'many'); });\n" }, {});
  try {
    const env = (dir) => ({ NODE_OPTIONS: `--require=${join(dir, 'setup.cjs')}` });
    const config = { runners: { node: { tests: 'tests/**/*.test.cjs', env: env(root) } } };
    const input = await collectNode({ root, config, runs: 1, strict: true });
    assert.equal(input.coverage.byTest['tests/label.test.cjs::t']['src/label.js'], '1-4');
    const mutation = await mutateNode({ root, config, input, scope: { changed: { 'src/label.js': '' } }, jobs: 2 });
    agreeWithFullRuns(root, mutation, ['--test', 'tests/label.test.cjs'], env);
    const boundary = mutation.mutants.find((m) => m.line === 2 && m.operator === 'boundary');
    assert.equal(boundary.status, 'error', 'the test process ran the original text; only its child ran the fault');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('review 3 finding 6: shards may disagree only for a loader reason; a read failure in one shard refuses the merge', async () => {
  const part = (index, entry) => ({ file: `s${index}.json`, input: {
    spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: process.versions.node },
    sources: { 'src/a.mjs': entry },
    tests: [], coverage: { granularity: 'test', byTest: {}, setup: {} },
    collection: { runs: 1, shard: { index, total: 2, suite: 'x', files: {} } } } });
  const measured = { coverable: '1-3', hash: 'sha256:a' };
  const { digest } = await import('../src/cli/collection.mjs');
  const fix = (parts) => { const s = digest(JSON.stringify([])); for (const p of parts) p.input.collection.shard.suite = s; return parts; };
  assert.throws(() => mergeInputs(fix([part(1, measured), part(2, { coverable: '', hash: 'sha256:a', unmeasured: 'not read by the node:test runner: EACCES' })])), /differ in sources: src\/a\.mjs/);
  const merged = mergeInputs(fix([part(1, measured), part(2, { coverable: '', hash: 'sha256:a', unmeasured: 'transformed by a loader without a usable source map, so its lines are not measured: evaluated script has no inline source map' })]));
  assert.match(merged.sources['src/a.mjs'].unmeasured, /^transformed by a loader/);
});
