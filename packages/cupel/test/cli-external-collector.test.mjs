import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/cupel.mjs', import.meta.url));
const sample = fileURLToPath(new URL('../../../spec/conformance/cases/001-report-minimal/input.json', import.meta.url));

test('configured external collector runs at root and supplies its --out input', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-external-test-')));
  try {
    const stub = join(root, 'collector.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';\nimport { argv, cwd } from 'node:process';\nif (cwd() !== ${JSON.stringify(root)}) process.exit(9);\nwriteFileSync(argv[argv.indexOf('--out') + 1], ${JSON.stringify(readFileSync(sample, 'utf8'))});\n`);
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: { custom: { collector: `"${process.execPath}" "${stub}"` } } }));
    const out = join(root, 'collected.json');
    const run = spawnSync(process.execPath, [bin, 'report', '--no-mutation', '--out', out, '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(readFileSync(sample, 'utf8')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Python project without node tests selects the bundled pytest collector', (t) => {
  const python = '/Users/vid/codecrystal/.venv/bin/python';
  const available = spawnSync(python, ['-c', 'import pytest'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (available.status !== 0) { t.skip('pytest unavailable in read-only CodeCrystal Python 3.14 environment'); return; }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cupel-auto-pytest-')));
  try {
    const fixture = fileURLToPath(new URL('../../../spec/conformance/adapters/pytest/', import.meta.url));
    cpSync(join(fixture, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(fixture, 'tests'), join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    const out = join(root, 'input.json');
    const run = spawnSync(process.execPath, [bin, 'label', '--runs', '1', '--out', out], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(python)}:${process.env.PATH}`, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(run.status, 0, run.stderr);
    const input = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(input.runtime.name, 'python');
    assert.equal(input.tests.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
