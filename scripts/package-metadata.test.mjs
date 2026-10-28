import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const root = JSON.parse(read('package.json'));
const npm = JSON.parse(read('packages/cupel/package.json'));
const python = read('packages/cupel-py/pyproject.toml');

test('npm is at 0.1.2 and the unchanged Python collector at 0.1.0, both with MIT metadata', () => {
  assert.equal(root.license, 'MIT');
  assert.equal(npm.license, 'MIT');
  assert.equal(npm.version, '0.1.2');
  assert.match(python, /^version = "0\.1\.0"$/m);
  assert.match(python, /^license = "MIT"$/m);
  assert.match(python, /^license-files = \["LICENSE", "NOTICE"\]$/m);
  assert.equal(root.private, true);
  assert.equal(npm.private, true);
  assert.match(python, /^\s*"Private :: Do Not Upload",$/m);
  assert.ok(npm.files.includes('LICENSE'));
  assert.ok(npm.files.includes('NOTICE'));
});

test('npm and Python distribute the canonical MIT grant and Vibernt notice', () => {
  const license = read('LICENSE');
  // https://spdx.org/licenses/MIT.html, owner/year substituted and LF endings.
  assert.equal(createHash('sha256').update(license).digest('hex'),
    '991cbbf113726b8011eb434ad7c81d289e11bcb583f7dc217dc8b38eef4a8d05');
  const notice = read('NOTICE');
  assert.match(notice, /^Cupel\nCopyright 2026 Vibernt\n/);
  assert.match(notice, /This product includes software developed at Vibernt\./);
  for (const packagePath of ['packages/cupel', 'packages/cupel-py']) {
    assert.equal(read(`${packagePath}/LICENSE`), license, `${packagePath} LICENSE drifted`);
    assert.equal(read(`${packagePath}/NOTICE`), notice, `${packagePath} NOTICE drifted`);
  }
});
