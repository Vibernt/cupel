// Checks the conformance suite itself: every case is well formed, every engine rule in the spec has a
// positive and a negative case, and the generated files match spec/conformance/build.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/engine/schema.mjs';
import { match } from '../src/conformance/match.mjs';

const SPEC = fileURLToPath(new URL('../../../spec/', import.meta.url));
const CASES = `${SPEC}conformance/cases/`;
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schema = (name) => read(`${SPEC}schemas/${name}.schema.json`);
const caseDirs = readdirSync(CASES).sort();

test('there are at least 30 cases', () => {
  assert.ok(caseDirs.length >= 30, `${caseDirs.length} cases`);
});

test('every case is well formed and its inputs and config validate', () => {
  for (const dir of caseDirs) {
    const files = readdirSync(`${CASES}${dir}`).sort();
    const c = read(`${CASES}${dir}/case.json`);
    assert.deepEqual(validate(schema('case'), c), [], `${dir}/case.json`);
    const inputs = c.command === 'guard' || files.includes('base.json') ? ['base.json', 'head.json'] : ['input.json'];
    for (const f of inputs) assert.ok(files.includes(f), `${dir} needs ${f}`);
    assert.ok(files.includes('expected.json'), `${dir} needs expected.json`);
    // An I1-negative case must really be invalid, in the document its diagnostic names.
    const codes = (read(`${CASES}${dir}/expected.json`).diagnostics ?? []).map((d) => d.code);
    const expectInvalid = c.rules.some((r) => r.id === 'I1' && r.polarity === 'negative') && codes.includes('invalid-input');
    for (const f of inputs) {
      const errors = validate(schema('input'), read(`${CASES}${dir}/${f}`));
      if (expectInvalid) assert.notDeepEqual(errors, [], `${dir}/${f} should be invalid`);
      else assert.deepEqual(errors, [], `${dir}/${f}`);
    }
    if (files.includes('config.json')) assert.deepEqual(validate(schema('config'), read(`${CASES}${dir}/config.json`)), [], `${dir}/config.json`);
  }
});

test('every engine rule in the spec has a positive and a negative case', () => {
  const text = readFileSync(`${SPEC}SPEC.md`, 'utf8');
  const specRules = new Set([...text.matchAll(/\*\*([ITSACGPLREV]\d+)\b/g)].map((m) => m[1]));
  const seen = new Map();
  for (const dir of caseDirs) {
    for (const r of read(`${CASES}${dir}/case.json`).rules) {
      assert.ok(specRules.has(r.id), `${dir} cites ${r.id}, which the spec does not define`);
      if (!seen.has(r.id)) seen.set(r.id, new Set());
      seen.get(r.id).add(r.polarity);
    }
  }
  const missing = [...specRules].sort().flatMap((id) =>
    ['positive', 'negative'].filter((p) => !seen.get(id)?.has(p)).map((p) => `${id} ${p}`));
  assert.deepEqual(missing, []);
});

test('generated cases match spec/conformance/build.mjs', () => {
  const r = spawnSync(process.execPath, [`${SPEC}conformance/build.mjs`, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the matcher follows the spec', () => {
  assert.deepEqual(match({ a: 1 }, { a: 1, b: 2 }), []);
  assert.deepEqual(match({ a: '$absent' }, { b: 1 }), []);
  assert.equal(match({ a: '$absent' }, { a: null }).length, 1);
  assert.equal(match([1, 2], [1, 2, 3]).length, 1);
  assert.equal(match({ a: [{ x: 1 }] }, { a: [{ x: 2, y: 3 }] }).length, 1);
  assert.equal(match(60, 60.0).length, 0);
});

const ENGINE = new URL('../src/engine/index.mjs', import.meta.url);
test('the engine passes every conformance case', { skip: !existsSync(ENGINE) && 'engine not built yet (M3)' }, async () => {
  const { run } = await import(ENGINE);
  const schemas = { input: schema('input'), config: schema('config'), report: schema('report') };
  const failures = [];
  for (const dir of caseDirs) {
    const p = (f) => `${CASES}${dir}/${f}`;
    const c = read(p('case.json'));
    const inputs = existsSync(p('base.json')) ? { base: read(p('base.json')), head: read(p('head.json')) } : { input: read(p('input.json')) };
    if (existsSync(p('assertions.json'))) inputs.assertions = read(p('assertions.json'));
    const config = existsSync(p('config.json')) ? read(p('config.json')) : {};
    const { report, exit } = run(c.command, inputs, config, c.args ?? {}, schemas);
    const problems = match(read(p('expected.json')), report);
    if (c.forbidVocabulary && report.review) {
      const scan = (value, path = '') => {
        if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${path}/${i}`));
        else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
          if (/retire|remove|delete|redundant/i.test(key)) problems.push(`forbidden key ${path}/${key}`);
          scan(v, `${path}/${key}`);
        } else if (typeof value === 'string' && path !== '/notice' && /retire|remove|delete|redundant/i.test(value)) problems.push(`forbidden value ${path}`);
      };
      scan(report.review);
    }
    if (exit !== c.expectExit) problems.unshift(`exit: expected ${c.expectExit}, got ${exit}`);
    if (problems.length) failures.push(`${dir}\n    ${problems.join('\n    ')}`);
  }
  assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
});
