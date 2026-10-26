import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGo } from '../src/collect/go/index.mjs';
import { scanGo, shape } from '../src/collect/go/lex.mjs';
import { definitions } from '../src/collect/go/tests.mjs';
import { match } from '../src/conformance/match.mjs';
import { validate } from '../src/engine/schema.mjs';
import { run } from '../src/engine/index.mjs';
import { requireCollector } from '../src/cli/collect.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = join(repo, 'spec/conformance/adapters/go');
const bin = join(repo, 'packages/cupel/bin/cupel.mjs');
const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((name) => [name,
  JSON.parse(readFileSync(join(repo, `spec/schemas/${name}.schema.json`), 'utf8'))]));
const hasGo = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
mkdirSync(join(repo, '.scratch/go-test-cache'), { recursive: true });
process.env.GOCACHE = join(repo, '.scratch/go-test-cache');

test('Go fixture matches hand-written expected input, schema, and report', { skip: !hasGo && 'go unavailable' }, async () => {
  const root = mkdtempSync(join(repo, '.scratch/go-fixture-'));
  let input;
  try {
    cpSync(fixture, root, { recursive: true, filter: (path) => !path.startsWith(join(fixture, '.scratch')) });
    input = await collectGo({ root, runs: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(match(expected, input), []);
  assert.deepEqual(validate(schemas.input, input), []);
  const { report, exit } = run('report', { input }, {}, {}, schemas);
  assert.equal(exit, 0, JSON.stringify(report.diagnostics));
  assert.deepEqual(report.diagnostics, []);
  assert.match(input.runtime.version, /^\d+\.\d+/);
  assert.ok(input.tests.every((item) => item.durationsMs.length === 2));
  assert.ok(Object.values(input.shapes).every((hashes) => hashes.length > 0));
});

test('Go K13 unions three runs and marks a branch that changes per run', { skip: !hasGo && 'go unavailable' }, async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/go-k13-'));
  try {
    cpSync(fixture, root, { recursive: true, filter: (path) => !path.startsWith(join(fixture, '.scratch')) });
    mkdirSync(join(root, '.scratch'), { recursive: true });
    writeFileSync(join(root, 'branch.go'), 'package fixture\nfunc Pick(n int) int {\n if n%2 == 0 {\n  return 1\n }\n return 2\n}\n');
    writeFileSync(join(root, 'branch_test.go'), `package fixture
import (
 "os"
 "strconv"
 "testing"
)
func TestBranch(t *testing.T) {
 for n := 0; ; n++ {
  file, err := os.OpenFile(".scratch/seen-"+strconv.Itoa(n), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
  if os.IsExist(err) { continue }
  if err != nil { t.Fatal(err) }
  file.Close()
  want := 2
  if n%2 == 0 { want = 1 }
  if got := Pick(n); got != want { t.Fatalf("got %d", got) }
  break
 }
}
`);
    const input = await collectGo({ root, runs: 3, tests: 'branch_test.go' });
    assert.deepEqual(input.tests.map((row) => row.id), ['branch_test.go::TestBranch']);
    assert.match(input.coverage.unstable['branch.go'], /4/);
    assert.match(input.coverage.unstable['branch.go'], /6/);
    assert.match(input.coverage.byTest['branch_test.go::TestBranch']['branch.go'], /4/);
    assert.match(input.coverage.byTest['branch_test.go::TestBranch']['branch.go'], /6/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Go collector CLI and automatic external selection work', { skip: !hasGo && 'go unavailable' }, async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/go-cli-'));
  try {
    cpSync(fixture, root, { recursive: true, filter: (path) => !path.startsWith(join(fixture, '.scratch')) });
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    assert.equal(typeof (await requireCollector(process.env, root, {})).collectNode, 'function');
    const env = { ...process.env, GOCACHE: join(root, '.scratch/cache'), GOMODCACHE: join(root, '.scratch/modcache'), GOPATH: join(root, '.scratch/gopath'), TMPDIR: join(root, '.scratch/tmp'), GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' };
    mkdirSync(env.TMPDIR, { recursive: true });
    const direct = spawnSync(process.execPath, [bin, 'collect-go', '--root', root, '--runs', '1', '--out', join(root, '.scratch/direct.json')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.deepEqual(match(expected, JSON.parse(readFileSync(join(root, '.scratch/direct.json'), 'utf8'))), []);
    const report = spawnSync(process.execPath, [bin, 'report', '--no-mutation', '--runs', '1', '--out', join(root, '.scratch/report-input.json'), '--json'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(report.status, 0, report.stderr);
    assert.deepEqual(match(expected, JSON.parse(readFileSync(join(root, '.scratch/report-input.json'), 'utf8'))), []);
    assert.equal(JSON.parse(report.stdout).kind, 'report');
    writeFileSync(join(root, 'math_test.go'), `${readFileSync(join(root, 'math_test.go'), 'utf8')}\nfunc TestSub(t *testing.T) { t.Run("child", func(t *testing.T) {}) }\n`);
    const withSubtest = spawnSync(process.execPath, [bin, 'collect-go', '--root', root, '--runs', '1', '--out', join(root, '.scratch/subtest.json')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(withSubtest.status, 0, withSubtest.stderr);
    assert.match(withSubtest.stderr, /math_test\.go::TestSub: subtests TestSub\/child/);
    assert.ok(JSON.parse(readFileSync(join(root, '.scratch/subtest.json'), 'utf8')).tests.some((item) => item.name === 'TestSub'));
    const autoSubtest = spawnSync(process.execPath, [bin, 'report', '--no-mutation', '--runs', '1', '--out', join(root, '.scratch/subtest-report.json'), '--json'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(autoSubtest.status, 0, autoSubtest.stderr);
    assert.match(autoSubtest.stderr, /math_test\.go::TestSub: subtests TestSub\/child/);
    writeFileSync(join(root, 'widget.test.mjs'), "import { test } from 'node:test'; test('frontend', () => {});\n");
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { go: { tests: '{math,other}_test.go' } } }));
    const configured = spawnSync(process.execPath, [bin, 'report', '--no-mutation', '--runs', '1', '--out', join(root, '.scratch/configured.json')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, '.scratch/configured.json'), 'utf8')).runtime.name, 'go');
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { go: { tests: 'missing_test.go' } } }));
    const unmatched = spawnSync(process.execPath, [bin, 'report', '--no-mutation', '--runs', '1'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(unmatched.status, 3);
    assert.match(unmatched.stderr, /no Go test files match missing_test\.go/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Go lexer excludes comments, keeps literal code, and masks literal values in shapes', () => {
  const a = scanGo('x := "// not a comment" /* comment\n only */\ny := `raw\ntext` // trailing\n');
  assert.deepEqual([...a.codeLines], [1, 3, 4]);
  assert.deepEqual(shape(scanGo('call("one", 12)').tokens), shape(scanGo('call("two", 33)').tokens));
});

test('Go source scan reads tags and detects direct interpreter and documentation pins', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/go-static-'));
  try {
    writeFileSync(join(root, 'sample_test.go'), `package sample
// cupel:minor
func TestReads(t *testing.T) {
  data, _ := os.ReadFile("README.md")
  if len(data) == 0 { t.Fatal("empty") }
  _ = exec.Command("go", "version")
}
`);
    const found = definitions({ Dir: root, ImportPath: 'example.com/sample', TestGoFiles: ['sample_test.go'] }, root).get('TestReads');
    assert.deepEqual(found.tags, ['minor']);
    assert.equal(found.spawnsInterpreter, true);
    assert.deepEqual(found.brittleness, [{ test: 'sample_test.go::TestReads', kind: 'doc-wording', line: 3 }]);
    assert.ok(found.shape.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
