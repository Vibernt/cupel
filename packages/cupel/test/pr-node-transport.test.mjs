import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceMutants } from '../src/mutate/sites.mjs';
import { mutationPipeSpec } from '../src/pr/profiles/node/mutation-host.mjs';
import { runNodeProfileAttempt as attempt } from '../src/pr/profiles/node/attempt.mjs';
import { nodeProfileProducerProof } from '../src/pr/producer.mjs';
import { collectNode } from '../src/collect/node/index.mjs';
import { analyse, coveredLines, formatLines } from '../src/collect/node/lines.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(repo, '.scratch');
const profile = fileURLToPath(new URL('../src/pr/profiles/node/', import.meta.url));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const runtimes = [['26', '/opt/homebrew/Cellar/node/26.7.0/bin/node']];
const runNodeProfileAttempt = options => attempt({ ...options,
  expectedProducerHash: nodeProfileProducerProof().producerHash });

function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pr-node-subject-'));
  const out = mkdtempSync(join(scratch, 'pr-node-output-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  const source = 'src/math.cjs';
  const original = 'module.exports = value => value + 1;\n';
  writeFileSync(join(root, source), original);
  writeFileSync(join(root, 'tests/math.test.cjs'), `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst math = require('../src/math.cjs');\ntest('math', () => { assert.match(fs.readFileSync(require.resolve('../src/math.cjs'), 'utf8'), /value \\+ 1/); assert.equal(math(2), 3); });\n`);
  const mutant = sourceMutants(root, source, original).find(item => item.operator === 'arith' && !item.filtered);
  assert.ok(mutant);
  return { root, out, source, original, mutant,
    close() { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

test('Node 22 v2 attempt refuses before subject execution', () => {
  const f = fixture();
  try {
    assert.throws(() => runNodeProfileAttempt({ root: f.root, file: 'tests/math.test.cjs',
      out: join(f.out, 'node22-refusal'), nodePath: '/opt/homebrew/opt/node@22/bin/node' }),
    /requires verified Node 26\.7\.0; got 22\.23\.3/);
  } finally { f.close(); }
});

test('mutation host refuses stale source bytes before a test starts', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, f.source), f.original.replace('value + 1', 'value + 2'));
    assert.throws(() => mutationPipeSpec({ root: f.root, source: f.source,
      sourceHash: sha(f.original), mutantId: f.mutant.id }), /source changed/);
  } finally { f.close(); }
});

test('missing or incorrect producer pin refuses before subject execution', () => {
  const f = fixture();
  try {
    const marker = join(f.out, 'subject-ran');
    writeFileSync(join(f.root, 'tests/math.test.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const options = { root: f.root, file: 'tests/math.test.cjs',
      out: join(f.out, 'producer-refusal'), nodePath: runtimes[0][1] };
    assert.throws(() => attempt(options), /independently trusted SHA-256 pin/);
    assert.throws(() => attempt({ ...options, out: join(f.out, 'wrong-producer-pin'),
      expectedProducerHash: `sha256:${'0'.repeat(64)}` }),
      /differs from trusted pin before attempt/);
    assert.equal(existsSync(marker), false);
  } finally { f.close(); }
});

test('stale private output cannot supply an earlier coverage record', () => {
  const f = fixture();
  try {
    const out = join(f.out, 'stale');
    mkdirSync(out);
    writeFileSync(join(out, 'coverage.json'), '{"version":"cupel-node-coverage/1"}');
    assert.throws(() => runNodeProfileAttempt({ root: f.root, file: 'tests/math.test.cjs',
      out, nodePath: runtimes[0][1] }), /fresh private output directory/);
  } finally { f.close(); }
});

for (const [version, nodePath] of runtimes) test(`Node ${version} attempt validates result, trace, loaded proof and fresh bytes`, () => {
  const f = fixture();
  try {
    const plain = runNodeProfileAttempt({ root: f.root, file: 'tests/math.test.cjs',
      out: join(f.out, 'attempt-plain'), nodePath });
    assert.equal(plain.kind, 'complete', plain.reasons.join('; '));
    assert.deepEqual(plain.rows.map(row => row.status), ['passed']);
    assert.ok(plain.coverage.tests[0].cov[f.source]?.length > 0);
    const spec = mutationPipeSpec({ root: f.root, source: f.source,
      sourceHash: sha(f.original), mutantId: f.mutant.id });
    assert.throws(() => runNodeProfileAttempt({ root: f.root, file: 'tests/math.test.cjs',
      out: join(f.out, 'attempt-forged'), nodePath,
      mutationSpec: { ...spec, replacementText: spec.replacementText.replace(' - ', ' + ') } }),
    /mutant pipe differs from regenerated source descriptor/);
    const changed = runNodeProfileAttempt({ root: f.root, file: 'tests/math.test.cjs',
      out: join(f.out, 'attempt-mutant'), nodePath, mutationSpec: spec });
    assert.equal(changed.kind, 'complete', changed.reasons.join('; '));
    assert.deepEqual(changed.rows.map(row => row.status), ['failed']);
    assert.equal(changed.mutation.loaded, true);
    writeFileSync(join(f.root, 'tests/unused.test.cjs'), "const {test}=require('node:test');test('unused',()=>{});\n");
    const unused = runNodeProfileAttempt({ root: f.root, file: 'tests/unused.test.cjs',
      out: join(f.out, 'attempt-unused'), nodePath, mutationSpec: spec });
    assert.equal(unused.kind, 'refuse');
    assert.ok(unused.reasons.includes('mutant was not loaded with expected identity'));
  } finally { f.close(); }
});

for (const [version, nodePath] of runtimes) for (const [kind, ext] of [['ESM', 'mjs'], ['erasable TypeScript', 'ts']]) {
  test(`Node ${version} ${kind} trusted loader transports a real mutant`, () => {
    const f = fixture();
    try {
      const source = `src/plus.${ext}`;
      const original = ext === 'ts' ? 'export const plus = (value: number): number => value + 1;\n' :
        'export const plus = value => value + 1;\n';
      const file = `tests/plus-${ext}.test.mjs`;
      writeFileSync(join(f.root, source), original);
      writeFileSync(join(f.root, file), `import {test} from 'node:test';\nimport {strict as assert} from 'node:assert';\nimport {plus} from '../${source}';\ntest('plus',()=>assert.equal(plus(2),3));\n`);
      const plain = runNodeProfileAttempt({ root: f.root, file, out: join(f.out, `plain-${ext}`), nodePath });
      assert.equal(plain.kind, 'complete', plain.reasons.join('; '));
      const mutant = sourceMutants(f.root, source, original).find(item => item.operator === 'arith' && !item.filtered);
      assert.ok(mutant);
      const spec = mutationPipeSpec({ root: f.root, source, sourceHash: sha(original), mutantId: mutant.id });
      const changed = runNodeProfileAttempt({ root: f.root, file,
        out: join(f.out, `mutant-${ext}`), nodePath, mutationSpec: spec });
      assert.equal(changed.kind, 'complete', `${changed.reasons.join('; ')}\n${readFileSync(join(f.out, `mutant-${ext}/runner.out`), 'utf8')}`);
      assert.deepEqual(changed.rows.map(row => row.status), ['failed']);
      assert.equal(changed.mutation.loaded, true);
      assert.equal(readFileSync(join(f.root, source), 'utf8'), original);
    } finally { f.close(); }
  });
}

test('caught Inspector and debug aliases persist as Node 26 profile refusals', () => {
  const f = fixture();
  try {
    const file = 'tests/inspector.test.cjs';
    writeFileSync(join(f.root, file), `const {test}=require('node:test');\nconst attempts=[\n['bare',()=>require('inspector')],['node',()=>require('node:inspector')],\n['promise-bare',()=>require('inspector/promises')],['promise-node',()=>require('node:inspector/promises')],\n['builtin',()=>process.getBuiltinModule('node:inspector')],\n['debug',()=>process._debugProcess(1)],['kill',()=>process.kill(1,'SIGUSR1')],\n['signal',()=>process.emit('SIGUSR1')]];\ntest('caught',()=>{for(const [name,fn] of attempts){let caught=false;try{fn()}catch{caught=true}if(!caught)throw Error(name)}});\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'inspector-attempt'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'refuse');
    assert.deepEqual(result.rows.map(row => row.status), ['passed']);
    assert.match(result.reasons.join('; '), /profile denials/);
    assert.ok(result.denials.filter(row => row.startsWith('forbidden-inspector:')).length >= 8);
  } finally { f.close(); }
});

test('Node 26 per-test coverage distinguishes branches and setup', () => {
  const f = fixture();
  try {
    const source = 'src/branch.cjs', file = 'tests/branch.test.cjs';
    writeFileSync(join(f.root, source), `const initialized = true;\nmodule.exports = value => {\n  if (value) return 'yes';\n  return 'no';\n};\n`);
    writeFileSync(join(f.root, file), `const {test}=require('node:test');\nconst assert=require('node:assert/strict');\nconst branch=require('../src/branch.cjs');\ntest('true branch',()=>assert.equal(branch(true),'yes'));\ntest('false branch',()=>assert.equal(branch(false),'no'));\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'branches'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'complete', `${result.reasons.join('; ')}\n${readFileSync(join(f.out, 'branches/runner.out'), 'utf8')}`);
    assert.deepEqual(result.rows.map(row => row.id), ['true branch#1', 'false branch#1']);
    const coverage = result.coverage;
    assert.ok(coverage.setup[source]?.length > 0);
    assert.ok(coverage.tests.every(row => row.cov[source]?.length > 0));
    assert.notDeepEqual(coverage.tests[0].cov[source], coverage.tests[1].cov[source]);
  } finally { f.close(); }
});

test('Node 26 nested and parameterized coverage rows reconcile with reporter', () => {
  const f = fixture();
  try {
    const file = 'tests/nested.test.cjs';
    writeFileSync(join(f.root, file), `const {describe,it}=require('node:test');\nconst assert=require('node:assert/strict');\nconst math=require('../src/math.cjs');\ndescribe('outer',()=>{for(const value of [1,2]) it('case '+value,()=>assert.equal(math(value),value+1));});\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'nested'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'complete', `${result.reasons.join('; ')}\n${readFileSync(join(f.out, 'nested/runner.out'), 'utf8')}\n${JSON.stringify(result.coverage)}`);
    assert.equal(result.rows.length, 2);
  } finally { f.close(); }
});

test('Node 26 coverage includes teardown and concurrent leaf results', () => {
  const f = fixture();
  try {
    const source = 'src/lifecycle.cjs', file = 'tests/lifecycle.test.cjs';
    const sourceText = `exports.one = () => { return 11; };\nexports.two = () => { return 22; };\nexports.cleanup = () => { return 33; };\n`;
    writeFileSync(join(f.root, source), sourceText);
    writeFileSync(join(f.root, file), `const {describe,it}=require('node:test');\nconst assert=require('node:assert/strict');\nconst functions=require('../src/lifecycle.cjs');\ndescribe('parallel',{concurrency:true},()=>{\n  it('one',async t=>{t.after(()=>assert.equal(functions.cleanup(),33));await Promise.resolve();assert.equal(functions.one(),11)});\n  it('two',async()=>{await Promise.resolve();assert.equal(functions.two(),22)});\n});\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'lifecycle'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'complete', `${result.reasons.join('; ')}\n${readFileSync(join(f.out, 'lifecycle/runner.out'), 'utf8')}`);
    assert.deepEqual(result.rows.map(row => row.id), ['parallel > one#1', 'parallel > two#1']);
    const [one, two] = result.coverage.tests;
    assert.ok(one.cov[source]?.length > 0);
    assert.ok(two.cov[source]?.length > 0);
    const cleanup = sourceText.indexOf('return 33');
    assert.ok(one.cov[source].some((start, index, values) => index % 2 === 0 && start <= cleanup && cleanup < values[index + 1]));
    assert.deepEqual(one.cov[source], two.cov[source]); // overlapping leaves receive the shared delta
  } finally { f.close(); }
});

test('ESM Inspector imports, createRequire, dependency aliases and trusted helper access refuse', () => {
  const f = fixture();
  try {
    const file = 'tests/inspector-esm.test.mjs';
    writeFileSync(join(f.root, 'src/inspector-dep.cjs'), `module.exports=()=>require('node:inspector');\n`);
    writeFileSync(join(f.root, file), `import {test} from 'node:test';\nimport {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\ntest('caught',async()=>{\nconst attempts=[()=>import('node:inspector'),()=>import('inspector/promises'),\n()=>require('node:inspector/promises'),()=>require('../src/inspector-dep.cjs')(),\n()=>import(${JSON.stringify(new URL('coverage.cjs', `file://${profile}/`).href)})];\nfor(const call of attempts){let caught=false;try{await call()}catch{caught=true}if(!caught)throw Error('inspector access allowed')}\n});\n`);
    const caught = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'esm-inspector'), nodePath: runtimes[0][1] });
    assert.equal(caught.kind, 'refuse');
    assert.deepEqual(caught.rows.map(row => row.status), ['passed']);
    assert.ok(caught.denials.length >= 5);
    writeFileSync(join(f.root, 'tests/inspector-static.test.mjs'),
      "import 'node:inspector';\nimport {test} from 'node:test';\ntest('must not start',()=>{});\n");
    const direct = runNodeProfileAttempt({ root: f.root, file: 'tests/inspector-static.test.mjs',
      out: join(f.out, 'static-inspector'), nodePath: runtimes[0][1] });
    assert.equal(direct.kind, 'refuse');
    assert.deepEqual(direct.rows.map(row => row.status), ['failed']);
    assert.ok(direct.denials.some(row => row.startsWith('forbidden-inspector:')));
  } finally { f.close(); }
});

test('Node 26 constrained per-test lines match ordinary collector on a branch fixture', async () => {
  const f = fixture();
  try {
    const source = 'src/choice.cjs', file = 'tests/choice.test.cjs';
    const text = `module.exports = value => {\n if (value) return 'left';\n return 'right';\n};\n`;
    writeFileSync(join(f.root, source), text);
    writeFileSync(join(f.root, file), `const {test}=require('node:test');\nconst assert=require('node:assert/strict');\nconst choice=require('../src/choice.cjs');\ntest('left',()=>assert.equal(choice(true),'left'));\ntest('right',()=>assert.equal(choice(false),'right'));\n`);
    const ordinary = await collectNode({ root: f.root,
      config: { runners: { node: { tests: 'tests/*.test.cjs' } } }, files: [file], runs: 1 });
    const selected = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'parity'), nodePath: runtimes[0][1] });
    assert.equal(selected.kind, 'complete', selected.reasons.join('; '));
    assert.deepEqual(selected.rows.map(row => [row.id, row.status]),
      ordinary.tests.map(row => [row.id.slice(`${file}::`.length) + '#1', row.status]));
    const analysed = analyse(text, { strict: true });
    for (let index = 0; index < selected.rows.length; index++) {
      const own = selected.coverage.tests[index].cov[source] ?? [];
      assert.equal(formatLines(coveredLines(analysed, own)),
        ordinary.coverage.byTest[ordinary.tests[index].id]?.[source] ?? '');
    }
    assert.equal(formatLines(coveredLines(analysed, selected.coverage.setup[source] ?? [])),
      ordinary.coverage.setup[file]?.[source] ?? '');
  } finally { f.close(); }
});

test('Node 26 coverage reconciles skipped tests without invented execution', () => {
  const f = fixture();
  try {
    const file = 'tests/skipped.test.cjs';
    writeFileSync(join(f.root, file), `const {test}=require('node:test');\ntest.skip('not run',()=>{throw Error('must not execute')});\ntest('ran',()=>{});\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'skipped'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'complete', `${result.reasons.join('; ')}\n${readFileSync(join(f.out, 'skipped/runner.out'), 'utf8')}`);
    assert.deepEqual(result.rows.map(row => row.status), ['skipped', 'passed']);
    assert.deepEqual(result.coverage.tests.map(row => row.fullName), ['ran']);
  } finally { f.close(); }
});

test('Node 26 child test inherits its parent test coverage', () => {
  const f = fixture();
  try {
    const file = 'tests/child.test.cjs';
    writeFileSync(join(f.root, file), `const {test}=require('node:test');\nconst assert=require('node:assert/strict');\nconst math=require('../src/math.cjs');\ntest('parent',async t=>{assert.equal(math(2),3);await t.test('child',()=>assert.equal(math(3),4));});\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'child'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'complete', `${result.reasons.join('; ')}\n${readFileSync(join(f.out, 'child/runner.out'), 'utf8')}\n${JSON.stringify(result.coverage)}`);
    assert.deepEqual(result.rows.map(row => row.id), ['parent > child#1']);
    assert.ok(result.verifiedCoverage.byTest['parent > child#1'][f.source]?.length > 0);
  } finally { f.close(); }
});

test('Node 26 Inspector grant retains network, child, worker, loader and write denials', () => {
  const f = fixture();
  try {
    const file = 'tests/other-denials.test.cjs';
    writeFileSync(join(f.root, file), `const {test}=require('node:test');\nconst fs=require('node:fs');\nconst Module=require('node:module');\ntest('caught restricted APIs',()=>{const attempts=[\n()=>fetch('https://example.invalid'),()=>require('node:child_process'),\n()=>require('node:worker_threads'),()=>fs.writeFileSync('src/math.cjs','tamper'),\n()=>Module.registerHooks({}),()=>process.dlopen({},'x.node')];\nfor(const call of attempts){let caught=false;try{call()}catch{caught=true}if(!caught)throw Error('restriction missing')}});\n`);
    const result = runNodeProfileAttempt({ root: f.root, file,
      out: join(f.out, 'other-denials'), nodePath: runtimes[0][1] });
    assert.equal(result.kind, 'refuse');
    assert.deepEqual(result.rows.map(row => row.status), ['passed']);
    assert.ok(result.denials.length >= 6, result.denials.join('; '));
    assert.equal(readFileSync(join(f.root, f.source), 'utf8'), f.original);
  } finally { f.close(); }
});
