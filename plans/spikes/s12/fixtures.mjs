import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const jsSources = (ext) => ({
  [`src/core.${ext}`]: 'export const plus = (n) => n + 1;\nexport const branch = (n) => n < 0 ? -1 : 1;\n',
  [`src/setup.${ext}`]: 'export const setupValue = () => 1;\n',
  [`src/text.${ext}`]: 'export const hidden = "green";\n',
  [`src/uncovered.${ext}`]: 'export const untouched = 1;\n',
});

const jestFiles = {
  'src/core.cjs': 'const plus = (n) => n + 1;\nconst branch = (n) => n < 0 ? -1 : 1;\nmodule.exports = { plus, branch };\n',
  'src/setup.cjs': 'const setupValue = () => 1;\nmodule.exports = { setupValue };\n',
  'src/text.cjs': 'const hidden = "green";\nmodule.exports = { hidden };\n',
  'src/uncovered.cjs': 'module.exports = { untouched: 1 };\n',
  'tests/core.test.cjs': "const { plus, branch } = require('../src/core.cjs');\ntest('plus', () => expect(plus(1)).toBe(2));\ntest('branch', () => { expect(branch(-1)).toBe(-1); expect(branch(0)).toBe(1); });\n",
  'tests/setup.test.cjs': "const { setupValue } = require('../src/setup.cjs');\nbeforeEach(() => expect(setupValue()).toBe(1));\ntest('setup observes helper', () => expect(setupValue()).toBe(1));\n",
  'tests/critical.test.cjs': "const { plus } = require('../src/core.cjs');\ntest('plus remains protected [critical]', () => expect(plus(2)).toBe(3));\n",
  'tests/param.test.cjs': "const { plus } = require('../src/core.cjs');\nfor (const [n, want] of [[3, 4], [4, 5]]) test('parameter ' + n, () => expect(plus(n)).toBe(want));\n",
  'tests/text.test.cjs': "const { readFileSync } = require('node:fs');\ntest('source text pin', () => expect(readFileSync(require.resolve('../src/text.cjs'), 'utf8')).toContain('green'));\n",
  'tests/text-runtime.test.cjs': "const { hidden } = require('../src/text.cjs');\ntest('runtime text shape', () => expect(typeof hidden).toBe('string'));\n",
  'tests/config.test.cjs': "const { readFileSync } = require('node:fs');\nconst config = JSON.parse(readFileSync(require.resolve('../config.json'), 'utf8'));\ntest('config enabled', () => expect(config.enabled).toBe(true));\n",
  'tests/independent.test.cjs': "test('independent', () => expect(2 + 2).toBe(4));\n",
  'config.json': '{"enabled":true}\n',
  'package.json': '{"name":"cupel-s12-jest","private":true,"devDependencies":{"jest":"30.2.0"}}\n',
  'jest.config.cjs': "module.exports = { testEnvironment: 'node', testRunner: 'jest-circus/runner', testMatch: ['<rootDir>/tests/*.test.cjs'], maxWorkers: 1, cache: false };\n",
};

function jsTests(runner, ext) {
  const node = runner === 'node';
  const imports = node ? "import { test, beforeEach } from 'node:test';\nimport assert from 'node:assert/strict';\n" :
    "import { test, expect, beforeEach } from 'vitest';\n";
  const eq = (actual, expected) => node ? `assert.equal(${actual}, ${expected})` : `expect(${actual}).toBe(${expected})`;
  return {
    [`tests/core.test.${ext}`]: `${imports}import { plus, branch } from '../src/core.${ext}';\ntest('plus', () => { ${eq('plus(1)', '2')}; });\ntest('branch', () => { ${eq('branch(-1)', '-1')}; ${eq('branch(0)', '1')}; });\n`,
    [`tests/setup.test.${ext}`]: `${imports}import { setupValue } from '../src/setup.${ext}';\nbeforeEach(() => { ${eq('setupValue()', '1')}; });\ntest('setup observes helper', () => { ${eq('setupValue()', '1')}; });\n`,
    [`tests/critical.test.${ext}`]: `${imports}import { plus } from '../src/core.${ext}';\ntest('plus remains protected [critical]', () => { ${eq('plus(2)', '3')}; });\n`,
    [`tests/param.test.${ext}`]: `${imports}import { plus } from '../src/core.${ext}';\nfor (const [n, want] of [[3, 4], [4, 5]]) test('parameter ' + n, () => { ${eq('plus(n)', 'want')}; });\n`,
    [`tests/text.test.${ext}`]: `${imports}import { readFileSync } from 'node:fs';\nconst text = readFileSync(new URL('../src/text.${ext}', import.meta.url), 'utf8');\ntest('source text pin', () => { ${node ? "assert.match(text, /green/)" : "expect(text).toContain('green')"}; });\n`,
    [`tests/text-runtime.test.${ext}`]: `${imports}import { hidden } from '../src/text.${ext}';\ntest('runtime text shape', () => { ${eq('typeof hidden', "'string'")}; });\n`,
    [`tests/config.test.${ext}`]: `${imports}import { readFileSync } from 'node:fs';\nconst config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));\ntest('config enabled', () => { ${eq('config.enabled', 'true')}; });\n`,
    [`tests/independent.test.${ext}`]: `${imports}test('independent', () => { ${eq('2 + 2', '4')}; });\n`,
  };
}

const py = {
  'src/__init__.py': '',
  'src/core.py': 'def plus(n):\n    return n + 1\n\ndef branch(n):\n    return -1 if n < 0 else 1\n',
  'src/setup.py': 'def setup_value():\n    return 1\n',
  'src/text.py': 'hidden = "green"\n',
  'src/uncovered.py': 'untouched = 1\n',
  'tests/test_core.py': 'from src.core import plus, branch\n\ndef test_plus():\n    assert plus(1) == 2\n\ndef test_branch():\n    assert branch(-1) == -1\n    assert branch(0) == 1\n',
  'tests/test_setup.py': 'import pytest\nfrom src.setup import setup_value\n\n@pytest.fixture(autouse=True)\ndef check_setup():\n    assert setup_value() == 1\n\ndef test_setup_observes_helper():\n    assert setup_value() == 1\n',
  'tests/test_critical.py': 'import pytest\nfrom src.core import plus\n\n@pytest.mark.cupel_critical\ndef test_plus_remains_protected():\n    assert plus(2) == 3\n',
  'tests/test_param.py': 'import pytest\nfrom src.core import plus\n\n@pytest.mark.parametrize("n,want", [(3, 4), (4, 5)])\ndef test_parameter(n, want):\n    assert plus(n) == want\n',
  'tests/test_text.py': 'from pathlib import Path\n\ndef test_source_text_pin():\n    text = (Path(__file__).parents[1] / "src/text.py").read_text()\n    assert "green" in text\n',
  'tests/test_text_runtime.py': 'from src.text import hidden\n\ndef test_runtime_text_shape():\n    assert isinstance(hidden, str)\n',
  'tests/test_config.py': 'import json\nfrom pathlib import Path\n\ndef test_config_enabled():\n    config = json.loads((Path(__file__).parents[1] / "config.json").read_text())\n    assert config["enabled"] is True\n',
  'tests/test_independent.py': 'def test_independent():\n    assert 2 + 2 == 4\n',
  'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\nmarkers = ["cupel_critical: critical test"]\n',
};

export function baseFiles(runner) {
  if (runner === 'pytest') return { ...py, 'config.json': '{"enabled":true}\n' };
  if (runner === 'jest') return { ...jestFiles };
  const ext = runner === 'node' ? 'mjs' : 'ts';
  return { ...jsSources(ext), ...jsTests(runner, ext), 'config.json': '{"enabled":true}\n',
    'package.json': '{"private":true,"type":"module"}\n',
    ...(runner === 'vitest' ? { 'vitest.config.mjs': "export default { test: { include: ['tests/**/*.test.ts'] } };\n" } : {}) };
}

export function writeFiles(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

const replace = (root, path, before, after) => {
  const full = join(root, path);
  const text = readFileSync(full, 'utf8');
  if (!text.includes(before)) throw new Error(`fault anchor missing: ${path}`);
  writeFileSync(full, text.replace(before, after));
};

export const cases = [
  { name: 'clean', expect: 'selected', oracle: 'pass' },
  { name: 'ordinary-source', expect: 'selected', oracle: 'fail' },
  { name: 'new-branch', expect: 'selected', oracle: 'fail' },
  { name: 'shared-setup', expect: 'selected', oracle: 'fail' },
  { name: 'new-test', expect: 'selected', oracle: 'fail' },
  { name: 'changed-parameter', expect: 'selected', oracle: 'fail' },
  { name: 'critical-removed', expect: 'refuse', oracle: 'pass' },
  { name: 'source-removed', expect: 'refuse', oracle: 'fail' },
  { name: 'source-renamed', expect: 'refuse', oracle: 'fail' },
  { name: 'line-shift', expect: 'selected', oracle: 'fail' },
  { name: 'config-input', expect: 'full', oracle: 'fail' },
  { name: 'unknown-source', expect: 'refuse', oracle: 'pass' },
  { name: 'stale-baseline', expect: 'refuse', oracle: 'pass' },
  { name: 'corrupt-baseline', expect: 'refuse', oracle: 'pass' },
  { name: 'source-text-pin', expect: 'selected', oracle: 'fail' },
];

export function inject(root, runner, name) {
  const ext = runner === 'node' ? 'mjs' : runner === 'vitest' ? 'ts' : runner === 'jest' ? 'cjs' : 'py';
  const core = `src/core.${ext}`; const setup = `src/setup.${ext}`;
  const param = runner === 'pytest' ? 'tests/test_param.py' : `tests/param.test.${ext}`;
  const critical = runner === 'pytest' ? 'tests/test_critical.py' : `tests/critical.test.${ext}`;
  const fault = runner === 'pytest' ? ['return n + 1', 'return n + 2'] : ['n + 1', 'n + 2'];
  if (name === 'ordinary-source') replace(root, core, ...fault);
  if (name === 'new-branch') replace(root, core, ...runner === 'pytest' ? ['return n + 1', 'if n == 1:\n        return 99\n    return n + 1'] : ['n + 1', 'n === 1 ? 99 : n + 1']);
  if (name === 'shared-setup') replace(root, setup, runner === 'pytest' ? 'return 1' : '=> 1', runner === 'pytest' ? 'return 2' : '=> 2');
  if (name === 'new-test') {
    const path = runner === 'pytest' ? 'tests/test_new.py' : `tests/new.test.${ext}`;
    writeFiles(root, { [path]: runner === 'pytest' ? 'def test_new_fails():\n    assert False\n' :
      runner === 'node' ? "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('new fails', () => assert.equal(1, 2));\n" :
        runner === 'jest' ? "test('new fails', () => expect(1).toBe(2));\n" :
          "import { test, expect } from 'vitest';\ntest('new fails', () => expect(1).toBe(2));\n" });
  }
  if (name === 'changed-parameter') replace(root, param, runner === 'pytest' ? '(3, 4)' : '[3, 4]', runner === 'pytest' ? '(3, 99)' : '[3, 99]');
  if (name === 'critical-removed') rmSync(join(root, critical));
  if (name === 'source-removed') rmSync(join(root, core));
  if (name === 'source-renamed') renameSync(join(root, core), join(root, `src/renamed.${ext}`));
  if (name === 'line-shift') { const path = join(root, core); writeFileSync(path, `\n\n\n${readFileSync(path, 'utf8')}`); replace(root, core, ...fault); }
  if (name === 'config-input') replace(root, 'config.json', 'true', 'false');
  if (name === 'unknown-source') replace(root, `src/uncovered.${ext}`, '1', '2');
  if (name === 'source-text-pin') replace(root, `src/text.${ext}`, 'green', 'red');
}
