// Commands that use git or a collector: plan --changed, guard --base, check --base and the report's
// optional evidence pass. Collection goes through the test-only stub collector and mutator
// (CUPEL_TEST_COLLECTOR and CUPEL_TEST_MUTATOR, honoured only with NODE_ENV=test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/engine/index.mjs';
import { parseUnifiedDiff, changedLines, unquotePath } from '../src/cli/git.mjs';

const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));
const CASES = `${SPEC}conformance/cases/`;
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((n) => [n, read(`${SPEC}schemas/${n}.schema.json`)]));

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-cli-git-')));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function repo(name, files) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
function write(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  }
}
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

function cli(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8',
    env: { ...GIT_ENV, NO_COLOR: '1', NODE_ENV: 'test', CUPEL_TEST_COLLECTOR: `${FIX}stub-collector.mjs`, CUPEL_TEST_MUTATOR: join(TMP, 'no-mutator.mjs'), ...extraEnv },
  });
}
const logOf = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('unified diffs become changed line sets', () => {
  const diff = [
    'diff --git a/src/a.mjs b/src/a.mjs',
    'index 1..2 100644',
    '--- a/src/a.mjs',
    '+++ b/src/a.mjs',
    '@@ -4 +4 @@',
    '-old',
    '+new',
    '@@ -8,0 +9,3 @@',
    '+a', '+b', '+c',
    '@@ -20,2 +22,0 @@',
    '-gone', '-gone',
    'diff --git a/src/new.mjs b/src/new.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.mjs',
    '@@ -0,0 +1,2 @@',
    '+x', '+y',
    'diff --git a/src/old.mjs b/src/old.mjs',
    'deleted file mode 100644',
    '--- a/src/old.mjs',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    'diff --git a/top.mjs b/top.mjs',
    '--- a/top.mjs',
    '+++ b/top.mjs',
    '@@ -1 +0,0 @@',
    '-first',
    'diff --git "a/sp ace/\\303\\251.mjs" "b/sp ace/\\303\\251.mjs"',
    '--- "a/sp ace/\\303\\251.mjs"',
    '+++ "b/sp ace/\\303\\251.mjs"',
    '@@ -2 +2,2 @@',
    '+z',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff), {
    'empty.txt': '',
    'img.png': '',
    'sp ace/é.mjs': '2-3',
    'src/a.mjs': '4,9-11,22',
    'src/new.mjs': '',
    'top.mjs': '1',
  });
  assert.equal(unquotePath('"a\\tb"'), 'a\tb');
});

test('plan --changed <ref> reads git diff --unified=0 (new and untracked files in full)', () => {
  const dir = repo('plan', {
    'src/a.mjs': lines(10),
    'tests/m.test.mjs': lines(3),
    'tests/gone.test.mjs': lines(2),
  });
  write(dir, {
    'src/a.mjs': lines(10, (i) => (i === 4 ? 'changed' : `line ${i}`)),
    'tests/staged.test.mjs': lines(2),
    'tests/untracked.test.mjs': lines(1),
  });
  git(dir, 'add', 'tests/staged.test.mjs');
  git(dir, 'rm', '-q', 'tests/gone.test.mjs');
  const changed = { 'src/a.mjs': '4', 'tests/staged.test.mjs': '', 'tests/untracked.test.mjs': '' };
  assert.deepEqual(changedLines(dir, 'HEAD'), changed);

  const c = `${CASES}034-plan-changed/`;
  const r = cli(dir, ['plan', '--changed', 'HEAD', '--input', `${c}input.json`, '--config', `${c}config.json`, '--json']);
  const expected = run('plan', { input: read(`${c}input.json`) }, read(`${c}config.json`), { changed }, schemas);
  assert.equal(r.stdout, `${JSON.stringify(expected.report, null, 2)}\n`, r.stderr);
  assert.equal(r.status, expected.exit);
  assert.equal(JSON.parse(r.stdout).plan.mode, 'changed');

  assert.equal(cli(dir, ['plan', '--changed', 'no-such-ref', '--input', `${c}input.json`]).status, 3);
  assert.equal(cli(TMP, ['plan', '--changed', 'HEAD', '--input', `${c}input.json`]).status, 3, 'outside a repository');
});

test('guard --base collects the base from git archive in a temp dir, runs prepare there, and never touches the working tree', () => {
  const c = `${CASES}040-guard-pass/`;
  const config = { runners: { node: { prepare: `"${process.execPath}" -e "require('fs').writeFileSync('prepared.txt', 'x')"` } } };
  const dir = repo('guard', { 'stub-input.json': read(`${c}base.json`), 'cupel.json': config, 'src/x.mjs': 'export {};\n' });
  write(dir, { 'stub-input.json': read(`${c}head.json`), 'notes.txt': 'untracked\n' });
  const status = git(dir, 'status', '--porcelain');
  const head = git(dir, 'rev-parse', 'HEAD');
  const log = join(TMP, 'guard.log');

  const r = cli(dir, ['guard', '--base', 'HEAD', '--no-mutation', '--json'], { CUPEL_STUB_LOG: log });
  const expected = run('guard', { base: read(`${c}base.json`), head: read(`${c}head.json`) }, config, {}, schemas);
  assert.equal(r.stdout, `${JSON.stringify(expected.report, null, 2)}\n`, r.stderr);
  assert.equal(r.status, 0);

  const [baseCall, headCall] = logOf(log);
  assert.ok(baseCall.root.startsWith(realpathSync(tmpdir())), baseCall.root);
  assert.notEqual(baseCall.root, dir);
  assert.equal(baseCall.prepared, true, 'prepare ran in the base directory');
  assert.equal(baseCall.prepare, null, 'the collector does not run prepare a second time');
  assert.equal(baseCall.seed, 20261021, 'the collector gets the effective config');
  assert.equal(existsSync(baseCall.root), false, 'the base directory is removed');
  assert.equal(headCall.root, dir);
  assert.equal(headCall.prepare, config.runners.node.prepare, 'the collector runs prepare for the working tree itself');

  assert.equal(git(dir, 'status', '--porcelain'), status);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(dir, 'prepared.txt')), false);

  // Human output, and a failing guard.
  write(dir, { 'stub-input.json': read(`${CASES}045-guard-critical-removed/head.json`) });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'head');
  const fail = cli(dir, ['guard', '--base', 'HEAD~1', '--base-input', `${CASES}045-guard-critical-removed/base.json`]);
  assert.equal(fail.status, 2, 'both --base and --base-input');
  const human = cli(dir, ['guard', '--base-input', `${CASES}045-guard-critical-removed/base.json`, '--no-mutation']);
  assert.equal(human.status, 1, human.stderr);
  assert.match(human.stdout, /^FAIL {2}critical-removed/m);
  assert.match(human.stdout, /guard failed/);

  assert.equal(cli(dir, ['guard', '--base', 'no-such-ref', '--no-mutation']).status, 3);
});

test('a failing prepare exits 3 and still cleans up', () => {
  const config = { runners: { node: { prepare: `"${process.execPath}" -e "process.exit(5)"` } } };
  const dir = repo('prepare-fails', { 'stub-input.json': read(`${CASES}040-guard-pass/base.json`), 'cupel.json': config });
  const r = cli(dir, ['guard', '--base', 'HEAD', '--no-mutation']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /prepare failed \(exit 5\)/);
});

test('a missing mutation module exits 3 unless the caller explicitly opts out', () => {
  const c = `${CASES}040-guard-pass/`;
  const dir = repo('missing-mutator', { 'stub-input.json': read(`${c}head.json`) });
  const missing = cli(dir, ['report', '--json']);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /mutation not available/);
  assert.equal(missing.stdout, '');

  const explicit = cli(dir, ['report', '--no-mutation', '--json']);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).command, 'report');
});

test('check: file arguments expand to their units; --base compares with the collected base', () => {
  const c = `${CASES}037-check-weakens/`;
  const dir = repo('check', { 'stub-input.json': read(`${c}base.json`) });
  write(dir, { 'stub-input.json': read(`${c}head.json`) });
  const head = read(`${c}head.json`);
  const file = head.tests.find((t) => (t.unit ?? t.id) === 'w').file;
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), '// test file\n');
  const units = [...new Set(head.tests.filter((t) => t.file === file).map((t) => t.unit ?? t.id))].sort();

  const r = cli(join(dir, file, '..'), ['check', file.split('/').pop(), '--base', 'HEAD', '--no-mutation', '--json']);
  const expected = run('check', { base: read(`${c}base.json`), head }, {}, { tests: units }, schemas);
  assert.equal(r.stdout, `${JSON.stringify(expected.report, null, 2)}\n`, r.stderr);
  assert.equal(r.status, 1);

  const human = cli(dir, ['check', 'w', '--base', 'HEAD', '--no-mutation']);
  assert.match(human.stdout, /^weakens {2}w {2}lost /m);

  // The same file named from --input, as written in the input.
  const byPath = cli(dir, ['check', file, '--input', `${c}head.json`, '--no-mutation', '--json']);
  assert.deepEqual(JSON.parse(byPath.stdout).check.verdicts.map((v) => v.id), units);
});

test('report: evidence pass is opt-in and adds review evidence', () => {
  const c = read(`${CASES}022-review-candidate-mutation-path/input.json`);
  const { mutation, ...rest } = c;
  const first = { ...rest, coverage: { granularity: 'test', byTest: c.coverage.byTest } };
  const dir = join(TMP, 'report');
  mkdirSync(dir, { recursive: true });
  write(dir, { 'stub-input.json': first, 'stub-mutation.json': mutation.mutants });
  const log = join(TMP, 'report.log');
  const env = { CUPEL_STUB_LOG: log, CUPEL_TEST_MUTATOR: `${FIX}stub-mutator.mjs` };

  const basic = cli(dir, ['report', '--json'], env);
  assert.equal(basic.status, 0, basic.stderr);
  assert.deepEqual(logOf(log).map((l) => (l.call === 'collectNode' ? ['collect', l.recheck, l.runs] : ['mutate', l.scope])), [
    ['collect', [], 2],
    ['mutate', { critical: true, changed: null, targeted: [] }],
  ]);
  assert.deepEqual(read(join(dir, '.cupel', 'input.json')).coverage.rechecked ?? [], []);

  rmSync(log);
  const r = cli(dir, ['report', '--evidence', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const final = read(join(dir, '.cupel', 'input.json'));
  assert.deepEqual(final.coverage.rechecked, ['r']);
  assert.deepEqual(final.mutation.targeted, ['r']);
  assert.equal(r.stdout, `${JSON.stringify(run('report', { input: final }, {}, {}, schemas).report, null, 2)}\n`);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.units.find((u) => u.id === 'r').hints, ['no-unique-evidence']);

  const calls = logOf(log).map((l) => (l.call === 'collectNode' ? ['collect', l.recheck, l.runs] : ['mutate', l.scope]));
  assert.deepEqual(calls, [
    ['collect', [], 2],
    ['mutate', { critical: true, changed: null, targeted: [] }],
    ['collect', ['r'], 1],
    ['mutate', { critical: false, changed: null, targeted: ['r'] }],
  ]);

  // Replaying the written input gives the same report.
  const replay = cli(dir, ['report', '--input', join(dir, '.cupel', 'input.json'), '--json']);
  assert.equal(replay.stdout, r.stdout);

  // --no-mutation skips mutation and the second pass; --out moves the input.
  rmSync(log);
  const plain = cli(dir, ['report', '--evidence', '--no-mutation', '--out', 'plain.json'], env);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^2 tests, 2 units, coverage 60% \(6\/10\), mutation score n\/a$/m);
  assert.match(plain.stdout, /no-unique-coverage-unverified: 1/);
  assert.equal(existsSync(join(dir, 'plain.json')), true);
  assert.deepEqual(logOf(log).map((l) => l.call), ['collectNode']);

  // An invalid config stops before collecting, with the engine's report.
  write(dir, { 'cupel.json': { advice: { slowMs: -1 } } });
  rmSync(log);
  const bad = cli(dir, ['report', '--json'], env);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).diagnostics[0].code, 'invalid-config');
  assert.deepEqual(logOf(log), []);
  rmSync(join(dir, 'cupel.json'));
});
