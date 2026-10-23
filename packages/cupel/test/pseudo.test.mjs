import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../src/collect/node/index.mjs';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { mutateNode, mutateVitest } from '../src/mutate/index.mjs';
import { sourceMutants } from '../src/mutate/sites.mjs';
import { analyzePseudo } from '../src/analysis/pseudo.mjs';
import { bodySites } from '../src/mutate/body-sites.mjs';
import { main } from '../src/cli/main.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const modules = '/Users/vid/codecrystal/hub-ts/node_modules';
const python = '/Users/vid/codecrystal/.venv/bin/python';
const source = `export function ignored(x) {
  const answer = x + 1;
  return answer * 1;
}
export function checked(x) {
  const answer = x + 2;
  return answer * 1;
}
`;

test('body sites include function forms and skip small bodies, constructors and generators', () => {
  const text = `function named() { const x = 1; return x; }
const expression = function() { const x = 2; return x; };
const arrow = () => { const x = 3; return x; };
class C {
  constructor() { this.x = 1; this.y = 2; }
  get value() { const x = 4; return x; }
  set value(x) { this.x = x; this.y = x; }
  method() { const x = 5; return x; }
  *generator() { yield 1; yield 2; }
}
function small() { return 1; }
`;
  const sites = bodySites('src/forms.mjs', text);
  assert.equal(sites.length, 6);
  assert.deepEqual(sites.filter((s) => s.variant === 0).map((s) => s.functionName),
    ['named', 'expression', 'arrow', 'value', 'value', 'method']);
  assert.deepEqual(sites.map((s) => s.id), bodySites('src/forms.mjs', text).map((s) => s.id));
});

function fixture(vitest) {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/pseudo-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', devDependencies: vitest ? { vitest: '4.1.11' } : {} }));
  const path = vitest ? 'src/logic.ts' : 'src/logic.mjs';
  const text = vitest ? source.replace('ignored(x)', 'ignored(x: number): number').replace('checked(x)', 'checked(x: number): number') : source;
  writeFileSync(join(root, path), text);
  const tests = vitest ? `import { test, expect } from 'vitest';
import { ignored, checked } from '../src/logic';
test('calls only', () => { ignored(3); });
test('checks value', () => { expect(checked(3)).toBe(5); });
` : `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignored, checked } from '../src/logic.mjs';
test('calls only', () => { ignored(3); });
test('checks value', () => { assert.equal(checked(3), 5); });
`;
  writeFileSync(join(root, vitest ? 'tests/logic.test.ts' : 'tests/logic.test.mjs'), tests);
  if (vitest) {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(modules, 'vitest'), join(root, 'node_modules/vitest'));
    symlinkSync(join(modules, 'typescript'), join(root, 'node_modules/typescript'));
  }
  return { root, path, text, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function hashes(root) {
  const result = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.scratch' || name === 'node_modules') continue;
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else result[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return result;
}

for (const vitest of [false, true]) {
  test(`${vitest ? 'Vitest' : 'Node'} function-scope mutation identifies exact pseudo evidence`,
    { skip: vitest && !existsSync(join(modules, 'vitest/package.json')) }, async (t) => {
      const p = fixture(vitest);
      t.after(p.cleanup);
      const before = hashes(p.root);
      const input = await (vitest ? collectVitest : collectNode)({ root: p.root, runs: 1 });
      const options = { root: p.root, input, scope: { functions: true }, jobs: 1,
        config: { mutation: { maxMutants: 10, maxSeconds: 60 } }, timeoutFloorMs: 500 };
      const first = await (vitest ? mutateVitest : mutateNode)(options);
      const second = await (vitest ? mutateVitest : mutateNode)(options);
      assert.deepEqual(first, second);
      assert.deepEqual(hashes(p.root), before);
      assert.equal(first.sampled, false);
      assert.equal(first.mutants.length, 3);
      assert.deepEqual(first.mutants.map((m) => m.status), ['survived', 'survived', 'killed']);
      const sites = sourceMutants(p.root, p.path, p.text, undefined, true);
      const report = analyzePseudo({ ...input, mutation: first }, sites);
      assert.deepEqual(report.pseudoTestedFunctions.map((f) => f.name), ['ignored']);
      assert.deepEqual(report.testedFunctions.map((f) => f.name), ['checked']);
      assert.deepEqual(report.pseudoTests.map((u) => u.id), [`tests/logic.test.${vitest ? 'ts' : 'mjs'}::calls only`]);
      assert.deepEqual(report.units.map((u) => u.pseudoShare), [1, 0]);
      if (!vitest) {
        const checkedUnit = 'tests/logic.test.mjs::checks value';
        const targeted = await mutateNode({ ...options, scope: { functions: true, targeted: [checkedUnit] } });
        assert.deepEqual(targeted.targeted, [checkedUnit]);
        const capped = await mutateNode({ ...options, config: { mutation: { maxMutants: 1, seed: 7 } } });
        assert.equal(capped.mutants.length, 1);
        assert.equal(capped.sampled, true);
        assert.equal(capped.mutants[0].operator, 'body-replace');
        const targetedCap = await mutateNode({ ...options, scope: { functions: true, targeted: [checkedUnit] },
          config: { mutation: { maxMutants: 1, seed: 7 } } });
        assert.equal(targetedCap.mutants[0].line, 6);
        assert.deepEqual(targetedCap.targeted, [checkedUnit]);
        const output = join(p.root, '.scratch', 'input.json');
        mkdirSync(join(p.root, '.scratch'), { recursive: true });
        writeFileSync(output, JSON.stringify({ ...input, mutation: first }));
        const stdout = [], stderr = [];
        const exit = await main(['pseudo', '--input', output, '--json'], {
          cwd: p.root, env: process.env, out: (s) => stdout.push(s), err: (s) => stderr.push(s),
        });
        assert.equal(exit, 0, stderr.join(''));
        assert.deepEqual(JSON.parse(stdout.join('')).pseudoTests.map((u) => u.id), ['tests/logic.test.mjs::calls only']);
        const liveOut = [], liveErr = [];
        const live = await main(['pseudo', '--json', '--quiet'], {
          cwd: p.root, env: process.env, out: (s) => liveOut.push(s), err: (s) => liveErr.push(s),
        });
        assert.equal(live, 0, liveErr.join(''));
        assert.deepEqual(JSON.parse(liveOut.join('')).pseudoTests.map((u) => u.id), ['tests/logic.test.mjs::calls only'], liveOut.join(''));
      }
    });
}

test('Python CLI collects, mutates, confirms and reports pseudo evidence',
  { skip: !existsSync(python) }, async (t) => {
    mkdirSync(join(repo, '.scratch'), { recursive: true });
    const root = mkdtempSync(join(repo, '.scratch/pseudo-python-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'logic.py'), `def ignored(x):
    answer = x + 1
    return answer

def checked(x):
    answer = x + 2
    return answer
`);
    writeFileSync(join(root, 'tests/test_logic.py'), `from logic import ignored, checked
def test_calls_only():
    ignored(3)

def test_checks_value():
    assert checked(3) == 5
`);
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { pytest: { collector: `${python} -m vibernt_cupel collect` } },
      mutation: { maxMutants: 10, maxSeconds: 60 } }));
    const before = hashes(root);
    const stdout = [], stderr = [];
    const exit = await main(['pseudo', '--json', '--quiet'], { cwd: root, env: process.env,
      out: (value) => stdout.push(value), err: (value) => stderr.push(value) });
    assert.equal(exit, 0, stderr.join(''));
    const report = JSON.parse(stdout.join(''));
    assert.deepEqual(report.pseudoTestedFunctions.map((f) => f.name), ['ignored']);
    assert.deepEqual(report.testedFunctions.map((f) => f.name), ['checked']);
    assert.deepEqual(report.pseudoTests.map((u) => u.id), ['tests/test_logic.py::test_calls_only']);
    assert.deepEqual(hashes(root), before);
  });
