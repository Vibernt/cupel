import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { goBodyVariants, goFaultHelper } from '../src/mutate-go/schemata.mjs';
import { applyGoSite } from '../src/mutate-go/sites.mjs';

function siteAt(text, number, needle, replacement, occurrence = 0, within = needle) {
  let found = -1;
  for (let index = 0; index <= occurrence; index++) {
    found = text.indexOf(needle, found + 1);
    if (found < 0) throw new Error(`missing ${needle} #${occurrence}`);
  }
  const local = needle.indexOf(within);
  if (local < 0) throw new Error(`${within} is not in ${needle}`);
  const start = found + local;
  return {
    number,
    start: Buffer.byteLength(text.slice(0, start)),
    end: Buffer.byteLength(text.slice(0, start + within.length)),
    original: within,
    replacement,
  };
}

function reason(result, number) {
  return result.refused.find((entry) => entry.number === number)?.reason;
}

test('renders three exact one-line body variants without moving source lines', () => {
  const source = 'package p\n\nfunc sum(a, b, c, d int) int {\n\treturn a + b + c + d\n}\n';
  const sites = [
    siteAt(source, 1, '+', '-', 0),
    siteAt(source, 2, '+', '-', 1),
    siteAt(source, 3, '+', '-', 2),
  ];
  const result = goBodyVariants(source, sites);
  const insertion = 'switch _cupelFaultActive() { case 1: return a - b + c + d ; case 2: return a + b - c + d ; case 3: return a + b + c - d ; };';
  assert.deepEqual(result.switched, [1, 2, 3]);
  assert.deepEqual(result.refused, []);
  assert.equal(result.text, source.replace('{\n', `{${insertion}\n`));
  assert.equal(result.text.split('\n').length, source.split('\n').length);
  assert.deepEqual(result.insertions, [{
    line: 3,
    column: [...'func sum(a, b, c, d int) int {'].length + 1,
    length: [...insertion].length,
  }]);

  // Removing only the declared insertion recovers more than token parity: the
  // original bytes, proving that comments and source positions were untouched.
  const at = source.indexOf('{') + 1;
  assert.equal(result.text.slice(0, at) + result.text.slice(at + insertion.length), source);
});

test('makes newline semicolons explicit, drops comments only from variants, and returns from void cases', () => {
  const source = [
    'package p',
    'func add(total *int, n int) { // keep',
    '\t*total = *total + // flatten',
    '\t\tn',
    '}',
    '',
  ].join('\n');
  const result = goBodyVariants(source, [siteAt(source, 1, '+', '-')]);
  assert.deepEqual(result.switched, [1]);
  assert.match(result.text, /case 1: \* total = \* total - n ; return;/);
  assert.match(result.text, /\/\/ keep/);
  assert.match(result.text, /\/\/ flatten/);
  assert.equal(result.text.split('\n').length, source.split('\n').length);

  const literals = 'package p\nfunc f(a, b int) int { _ = "a\\n"; _ = \'\\n\'; _ = `raw`; _ = .5; return a + b }\n';
  const literalResult = goBodyVariants(literals, [siteAt(literals, 2, '+', '-')]);
  assert.match(literalResult.text, /_ = "a\\n" ; _ = '\\n' ; _ = `raw` ; _ = \.5 ; return a - b/);
});

test('refuses labels, goto, recover, directives, literals, raw strings, and source-position behavior', () => {
  const cases = [
    ['label', 'package p\nfunc f(a, b int) int { again: return a + b }\n', 'label'],
    ['goto', 'package p\nfunc f(a, b int) int { goto done; done: return a + b }\n', 'label'],
    ['recover', 'package p\nfunc f(a, b int) int { defer func(){ _ = recover() }(); return a + b }\n', 'recover'],
    ['inside directive', 'package p\nfunc f(a, b int) int { //go:noinline\n return a + b }\n', 'directive'],
    ['leading directive', 'package p\n//go:noinline\nfunc f(a, b int) int { return a + b }\n', 'directive'],
    ['function literal', 'package p\nfunc f(a, b int) int { g := func() int { return a + b }; return g() }\n', 'function-literal'],
    ['multiline raw string', 'package p\nfunc f(a, b int) int { _ = `a\nb`; return a + b }\n', 'multiline-raw'],
    ['runtime caller', 'package p\nimport "runtime"\nfunc f(a, b int) int { _, _, _, _ = runtime.Caller(0); return a + b }\n', 'position'],
    ['panic location', 'package p\nfunc f(a, b int) int { if a == 0 { panic("x") }; return a + b }\n', 'position'],
    ['testing helper style', 'package p\nfunc helper(t T) { t.Helper() }\nfunc f(a, b int) int { return a + b }\n', 'position'],
  ];
  for (const [name, source, expected] of cases) {
    const result = goBodyVariants(source, [siteAt(source, 1, 'a + b', '-', 0, '+')]);
    assert.equal(reason(result, 1), expected, name);
    assert.equal(result.text, source, name);
  }
});

test('refuses cgo, build tags, uncertain lexing, over-budget bodies, and excess sites', () => {
  const cgo = 'package p\nimport "C"\nfunc f(a, b int) int { return a + b }\n';
  assert.equal(reason(goBodyVariants(cgo, [siteAt(cgo, 1, '+', '-')]), 1), 'cgo');

  const tagged = '//go:build linux\n\npackage p\nfunc f(a, b int) int { return a + b }\n';
  assert.equal(reason(goBodyVariants(tagged, [siteAt(tagged, 2, '+', '-')]), 2), 'build-tag');

  const uncertain = 'package p\nfunc f(a, b int) int { _ = 0xZZ; return a + b }\n';
  assert.equal(reason(goBodyVariants(uncertain, [siteAt(uncertain, 3, '+', '-')]), 3), 'unparsed');

  const plain = 'package p\nfunc f(a, b int) int { return a + b }\n';
  assert.equal(reason(goBodyVariants(plain, [siteAt(plain, 4, '+', '-')], { budget: 10 }), 4), 'budget');
  assert.deepEqual(goBodyVariants(plain, [siteAt(plain, 5, '+', '-')], { budget: 20 }).switched, [5]);

  const generic = 'package p\nfunc f[T ~int](a, b T) T { return a + b }\n';
  assert.equal(reason(goBodyVariants(generic, [siteAt(generic, 6, '+', '-')], { budget: 20 }), 6), 'budget');

  const many = 'package p\nfunc f(a, b, c, d int) int { return a + b + c + d }\n';
  const bounded = goBodyVariants(many, [
    siteAt(many, 7, '+', '-', 0), siteAt(many, 8, '+', '-', 1), siteAt(many, 9, '+', '-', 2),
  ], { perFunction: 2 });
  assert.deepEqual(bounded.switched, [7, 8]);
  assert.equal(reason(bounded, 9), 'bound');
});

test('validates site numbers and byte spans, including Unicode before a site', () => {
  const source = 'package p\nfunc é(a, b int) int { return a + b }\n';
  const valid = siteAt(source, 1, '+', '-');
  assert.deepEqual(goBodyVariants(source, [valid]).switched, [1]);
  assert.equal(reason(goBodyVariants(source, [{ ...valid, number: 0 }]), 0), 'number');
  assert.equal(reason(goBodyVariants(source, [{ ...valid, start: valid.start + 1 }]), 1), 'span');
  assert.equal(reason(goBodyVariants(source, [{ ...valid, original: '-' }]), 1), 'span');
  assert.equal(reason(goBodyVariants(source, [{ ...valid, original: undefined }]), 1), 'span');
});

test('renders a package-local helper that reads CUPEL_FAULT once as uint32', () => {
  const helper = goFaultHelper('fixture');
  assert.match(helper, /^package fixture\n/);
  assert.match(helper, /sync\.Once/);
  assert.match(helper, /strconv\.ParseUint\(os\.Getenv\("CUPEL_FAULT"\), 10, 32\)/);
  assert.match(helper, /func _cupelFaultActive\(\) uint32/);
  assert.throws(() => goFaultHelper('bad-name'), /package identifier/);
  assert.throws(() => goFaultHelper('package'), /package identifier/);
  assert.throws(() => goBodyVariants('package p\n', [], { helper: 'bad-name' }), /Go identifier/);
  assert.throws(() => goBodyVariants('package p\n', [], { helper: 'func' }), /Go identifier/);
});

test('switched Go bodies have parity with separately applied sites', { timeout: 120_000 }, (t) => {
  const version = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') return t.skip('go is not on PATH');
  assert.equal(version.status, 0, version.stderr);

  const scratch = resolve('.scratch', 'mutate-go-schemata-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'go.mod'), 'module example.com/cupel-schemata-parity\n\ngo 1.22\n');

  const source = `package main

import "fmt"

type calc struct { base int }

func arithmetic(a, b int) int { return a + b }
func comparison(a, b int) bool { return a < b }
func logic(a, b bool) bool { return a && b }
func add(total *int, n int) { *total = *total + n }
func named(a int) (out int) { out = a + 1; return }
func (c calc) value(n int) int { return c.base + n }
func pair(a int) (int, int) { return a + 1, a - 1 }

func main() {
	total := 4
	add(&total, 3)
	a, b := pair(5)
	fmt.Printf("%d|%t|%t|%d|%d|%d|%d,%d\\n", arithmetic(8, 3), comparison(2, 7), logic(true, false), total, named(6), (calc{base: 10}).value(2), a, b)
}
`;
  const sites = [
    siteAt(source, 1, 'return a + b', '-', 0, '+'),
    siteAt(source, 2, 'return a < b', '>=', 0, '<'),
    siteAt(source, 3, 'return a && b', '||', 0, '&&'),
    siteAt(source, 4, '*total = *total + n', '-', 0, '+'),
    siteAt(source, 5, 'out = a + 1', '-', 0, '+'),
    siteAt(source, 6, 'return c.base + n', '-', 0, '+'),
    siteAt(source, 7, 'return a + 1, a - 1', '-', 0, '+'),
  ];
  const environment = { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOWORK: 'off' };
  delete environment.CUPEL_FAULT;
  const run = (env = environment) => {
    const result = spawnSync('go', ['run', '.'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };

  writeFileSync(join(root, 'main.go'), source);
  const original = run();
  const individual = new Map();
  const bytes = Buffer.from(source);
  for (const site of sites) {
    writeFileSync(join(root, 'main.go'), applyGoSite(bytes, site));
    individual.set(site.number, run());
  }

  const switched = goBodyVariants(source, sites);
  assert.deepEqual(switched.switched, sites.map((site) => site.number));
  assert.deepEqual(switched.refused, []);
  writeFileSync(join(root, 'main.go'), switched.text);
  writeFileSync(join(root, 'cupel_fault.go'), goFaultHelper('main'));
  assert.equal(run(), original, 'unset switch preserves the original program');
  assert.equal(run({ ...environment, CUPEL_FAULT: 'invalid' }), original, 'invalid switch selects no fault');
  for (const site of sites) {
    assert.equal(run({ ...environment, CUPEL_FAULT: String(site.number) }), individual.get(site.number), `fault ${site.number}`);
  }
});
