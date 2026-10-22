// validate, import (cupel and JUnit XML), conformance, the shipped schemas, and usage errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/engine/index.mjs';
import { validate } from '../src/engine/schema.mjs';
import { parseXml } from '../src/cli/xml.mjs';

const BIN = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const PKG = fileURLToPath(new URL('../', import.meta.url));
const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));
const CASES = `${SPEC}conformance/cases/`;
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map((n) => [n, read(`${SPEC}schemas/${n}.schema.json`)]));

const CWD = mkdtempSync(join(tmpdir(), 'cupel-cli-files-'));
process.on('exit', () => rmSync(CWD, { recursive: true, force: true }));
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: CWD, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const tmp = (name, value) => {
  const p = join(CWD, name);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
};

test('the package ships schemas identical to spec/schemas (copy them over after a spec change)', () => {
  const spec = readdirSync(`${SPEC}schemas`).sort();
  assert.deepEqual(readdirSync(`${PKG}schemas`).sort(), spec);
  for (const f of spec) {
    assert.equal(readFileSync(`${PKG}schemas/${f}`, 'utf8'), readFileSync(`${SPEC}schemas/${f}`, 'utf8'),
      `packages/cupel/schemas/${f} differs from spec/schemas/${f}: run cp spec/schemas/*.json packages/cupel/schemas/`);
  }
});

test('check prints informational no-unique-evidence and exits 0', () => {
  const r = cli('check', 'new2', '--input', `${CASES}035-check-no-unique-evidence/input.json`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^no-unique-evidence {2}new2 {2}extend old$/m);
  assert.doesNotMatch(r.stdout, /adds-nothing|retire/);
});

test('validate: a good input, report and config exit 0', () => {
  const input = `${CASES}001-report-minimal/input.json`;
  const report = tmp('report.json', run('report', { input: read(input) }, {}, {}, schemas).report);
  for (const [file, kind] of [[input, 'input'], [report, 'report'], [`${CASES}020-consolidate-off/config.json`, 'config']]) {
    const r = cli('validate', file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`valid ${kind}`));
    const j = cli('validate', file, '--json');
    assert.deepEqual(JSON.parse(j.stdout), { file, kind, valid: true, errors: [] });
  }
});

test('validate: bad documents exit 1 with JSON pointers', () => {
  const bad = cli('validate', `${CASES}002-invalid-spec-version/input.json`, '--json');
  assert.equal(bad.status, 1);
  const out = JSON.parse(bad.stdout);
  assert.equal(out.kind, 'input');
  assert.equal(out.valid, false);
  assert.ok(out.errors.some((e) => e.path === '/spec'), bad.stdout);

  const integrity = cli('validate', `${CASES}003-unknown-test/input.json`);
  assert.equal(integrity.status, 1);
  assert.match(integrity.stdout, /\/coverage\/byTest\/ghost: unknown-test/);

  const config = cli('validate', tmp('bad-config.json', { tiers: { pathWords: ['--'], critical: 'src' } }));
  assert.equal(config.status, 1);
  assert.match(config.stdout, /invalid config/);
  assert.match(config.stdout, /\/tiers\/critical: invalid-config/);

  const words = cli('validate', tmp('bad-words.json', { tiers: { extraPathWords: ['--'] } }), '--json');
  assert.equal(words.status, 1);
  assert.deepEqual(JSON.parse(words.stdout).errors.map((e) => e.path), ['/tiers/extraPathWords/0']);

  const report = cli('validate', tmp('bad-report.json', { spec: 'cupel-spec/1', kind: 'report', command: 'report' }));
  assert.equal(report.status, 1);
  assert.match(report.stdout, /invalid report/);

  assert.equal(cli('validate', tmp('kind.json', { kind: 'other' })).status, 1);
  assert.equal(cli('validate', tmp('notjson.json', '{nope')).status, 1);
  assert.equal(cli('validate', join(CWD, 'missing.json')).status, 2);
});

test('import --format junit: nested suites, failure, error, skipped, reruns and entities', () => {
  const r = cli('import', '--format', 'junit', `${FIX}junit/nested.xml`, `${FIX}junit/rerun.xml`, '--runtime-name', 'node', '--runtime-version', '22.23.3');
  assert.equal(r.status, 0, r.stderr);
  const input = JSON.parse(r.stdout);
  assert.deepEqual(input, {
    spec: 'cupel-spec/1',
    kind: 'input',
    runtime: { name: 'node', version: '22.23.3' },
    sources: {},
    tests: [
      { id: 'Retry::flaky then passed', file: 'Retry', name: 'flaky then passed', status: 'passed', durationsMs: [250] },
      { id: 'calc.Divide::divides', file: 'calc.Divide', name: 'divides', status: 'failed', durationsMs: [1000500] },
      { id: 'calc.Divide::throws on zero', file: 'calc.Divide', name: 'throws on zero', status: 'failed', durationsMs: [300] },
      { id: 'suite-only::pending', file: 'suite-only', name: 'pending', status: 'passed', durationsMs: [2] },
      { id: 'tests/math.test.mjs::add sums two numbers [critical]', file: 'tests/math.test.mjs', name: 'add sums two numbers [critical]', tags: ['critical'], status: 'passed', durationsMs: [12, 10] },
      { id: 'tests/math.test.mjs::clamp > low bound & AB', file: 'tests/math.test.mjs', name: 'clamp > low bound & AB', status: 'passed', durationsMs: [5] },
    ],
    coverage: { granularity: 'file' },
  });
  assert.deepEqual(validate(schemas.input, input), []);

  const one = cli('import', '--format', 'junit', `${FIX}junit/nested.xml`, '--out', join(CWD, 'junit-input.json'));
  assert.equal(one.status, 0, one.stderr);
  const written = read(join(CWD, 'junit-input.json'));
  assert.equal(written.tests.find((t) => t.name === 'pending').status, 'skipped');
  assert.deepEqual(written.runtime, { name: 'unknown', version: 'unknown' });

  // The imported input drives the engine at file granularity.
  const rep = cli('report', '--input', join(CWD, 'junit-input.json'), '--json');
  assert.equal(rep.status, 0, rep.stderr);
  assert.equal(JSON.parse(rep.stdout).suite.failed, 2);
});

test('import refuses malformed XML and unknown formats (exit 2), and checks cupel inputs', () => {
  const broken = cli('import', '--format', 'junit', `${FIX}junit/broken.xml`);
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /not well-formed XML/);
  assert.equal(cli('import', '--format', 'junit', tmp('entity.xml', '<!DOCTYPE x [<!ENTITY a "b">]><testsuite/>')).status, 2);
  assert.equal(cli('import', '--format', 'csv', `${FIX}junit/nested.xml`).status, 2);

  const good = cli('import', `${CASES}001-report-minimal/input.json`);
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout), read(`${CASES}001-report-minimal/input.json`));
  const bad = cli('import', `${CASES}003-unknown-test/input.json`);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown-test/);
});

test('the XML parser handles CDATA, comments, entities and quoting', () => {
  const el = parseXml('<?xml version="1.0"?><!-- c --><a x=\'1 &amp; 2\'><b><![CDATA[<raw>]]></b>t&#233;xt<c/></a>');
  assert.equal(el.name, 'a');
  assert.equal(el.attrs.x, '1 & 2');
  assert.equal(el.text, 'téxt');
  assert.deepEqual(el.children.map((c) => [c.name, c.text]), [['b', '<raw>'], ['c', '']]);
  for (const bad of ['<a>', '<a></b>', '<a x="1" x="2"/>', '<a>&bogus;</a>', '<a/><b/>', 'text', '<a x=1/>']) {
    assert.throws(() => parseXml(bad), undefined, bad);
  }
});

test('conformance: an adapter that reproduces the fixture passes; one that does not fails', () => {
  const ok = cli('conformance', '--adapter', `"${process.execPath}" "${FIX}fake-adapter.mjs"`);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^pass {2}node-test$/m);

  const bad = cli('conformance', '--adapter', `"${process.execPath}" "${FIX}fake-adapter.mjs" broken`, '--json');
  assert.equal(bad.status, 1);
  const out = JSON.parse(bad.stdout);
  assert.equal(out.pass, false);
  assert.equal(out.fixtures[0].fixture, 'node-test');
  assert.match(out.fixtures[0].mismatches[0], /^\/tests: expected 5 items, got 4/);

  const fails = cli('conformance', '--adapter', `"${process.execPath}" -e "process.exit(4)"`);
  assert.equal(fails.status, 1);
  assert.match(fails.stdout, /adapter exited 4/);
  assert.equal(cli('conformance', '--adapter', 'true', '--fixtures', join(CWD, 'nowhere')).status, 3);
});

test('usage errors exit 2', () => {
  const cases = [
    ['report', '--bogus'],
    ['report', '--runs', '0', '--input', `${CASES}001-report-minimal/input.json`],
    ['report', 'extra-positional'],
    ['guard', '--head-input', `${CASES}040-guard-pass/head.json`],
    ['guard', '--base', '--upload-pack=x', '--head-input', `${CASES}040-guard-pass/head.json`],
    ['guard', '--base', 'main', '--base-input', `${CASES}040-guard-pass/base.json`],
    ['check', '--input', `${CASES}035-check-no-unique-evidence/input.json`],
    ['check', '--input', `${CASES}035-check-no-unique-evidence/input.json`, '--head-input', `${CASES}035-check-no-unique-evidence/input.json`, 'x'],
    ['plan', '--changed', 'HEAD', '--changed-lines', 'x.json'],
    ['plan', '--input', join(CWD, 'missing.json')],
    ['report', '--input', `${CASES}001-report-minimal/input.json`, '--config', join(CWD, 'missing.json')],
    ['import'],
    ['validate'],
    ['conformance'],
    ['mcp', '--bogus'],
    ['frobnicate'],
    [],
  ];
  for (const args of cases) {
    const r = cli(...args);
    assert.equal(r.status, 2, `cupel ${args.join(' ')}: ${r.stderr}`);
  }
  assert.equal(cli('report', '--help').status, 0);
});

test('report without --input and without a collector exits 3 with one line', () => {
  const r = spawnSync(process.execPath, [BIN, 'report'], {
    cwd: CWD, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', CUPEL_TEST_COLLECTOR: join(CWD, 'no-such-collector.mjs') },
  });
  assert.equal(r.status, 3);
  assert.equal(r.stderr, 'cupel report: collector not available\n');
});

test('CUPEL_TEST_COLLECTOR is ignored outside NODE_ENV=test', () => {
  writeFileSync(join(CWD, 'stub-input.json'), readFileSync(`${CASES}001-report-minimal/input.json`));
  const env = { ...process.env, CUPEL_TEST_COLLECTOR: `${FIX}stub-collector.mjs`, NODE_ENV: 'production' };
  const r = spawnSync(process.execPath, [BIN, 'report', '--no-mutation', '--out', join(CWD, 'out.json')], { cwd: CWD, encoding: 'utf8', env });
  // The real collector (or its absence) decides what happens; the stub must not have produced this input.
  const usedStub = r.status === 0 && existsSync(join(CWD, 'out.json')) && read(join(CWD, 'out.json')).tests.some((t) => t.id === 't1');
  assert.equal(usedStub, false);
});
