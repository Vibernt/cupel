import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOriginalVitestConfig } from '../src/collect/vitest/config-loader.mjs';

const scratch = join(fileURLToPath(new URL('../../../', import.meta.url)), '.scratch');

test('config loader shims ESM globals for the user config and restores prior values', async () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'vitest-config-loader-'));
  const config = join(root, 'vitest.config.mjs');
  const prior = { __dirname: globalThis.__dirname, __filename: globalThis.__filename, require: globalThis.require };
  const owned = Object.fromEntries(Object.keys(prior).map((key) => [key, Object.hasOwn(globalThis, key)]));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}');
    writeFileSync(config, 'export default { directory: __dirname, filename: __filename, packageFile: require.resolve("./package.json") };');
    globalThis.__dirname = 'previous directory';
    globalThis.__filename = 'previous filename';
    globalThis.require = 'previous require';
    assert.deepEqual(await loadOriginalVitestConfig(config, root, {}), {
      directory: dirname(config), filename: config, packageFile: join(root, 'package.json'),
    });
    assert.equal(globalThis.__dirname, 'previous directory');
    assert.equal(globalThis.__filename, 'previous filename');
    assert.equal(globalThis.require, 'previous require');
  } finally {
    for (const key of Object.keys(prior)) {
      if (owned[key]) globalThis[key] = prior[key];
      else delete globalThis[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
