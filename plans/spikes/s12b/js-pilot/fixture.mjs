import { baseFiles, writeFiles } from '../../s12/fixtures.mjs';

const extOf = runner => runner === 'node' ? 'mjs' : runner === 'vitest' ? 'ts' : 'cjs';
export function createPilotFixture(root, runner) {
  const ext = extOf(runner);
  const files = baseFiles(runner);
  if (runner === 'jest') {
    files['src/cache.cjs'] = "const { readFileSync } = require('node:fs');\nexports.enabled = JSON.parse(readFileSync(require.resolve('../config.json'), 'utf8')).enabled;\n";
    files['tests/cache-a.test.cjs'] = "const a = require('../src/cache.cjs'); const b = require('../src/cache.cjs');\ntest('cached A', () => expect(a.enabled && b.enabled).toBe(true));\n";
    files['tests/cache-b.test.cjs'] = "const a = require('../src/cache.cjs'); const b = require('../src/cache.cjs');\ntest('cached B', () => expect(a.enabled && b.enabled).toBe(true));\n";
    files['tests/io.test.cjs'] = `const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { readFileSync: captured, createReadStream } = fs;
test('alias async stream probes', async () => {
  expect(captured(require.resolve('../src/text.cjs'), 'utf8')).toContain('green');
  expect(await fsp.readFile(require.resolve('../config.json'), 'utf8')).toContain('true');
  let data = ''; for await (const chunk of createReadStream(require.resolve('../src/text.cjs'))) data += chunk;
  expect(data).toContain('green');
  expect(fs.existsSync(__dirname + '/../src/absent.cjs')).toBe(false);
  try { fs.statSync(__dirname + '/../src/absent.cjs'); } catch (error) { expect(error.code).toBe('ENOENT'); }
  expect(fs.readdirSync(__dirname + '/../src')).toContain('text.cjs');
});
`;
  } else {
    const imports = runner === 'node' ?
      "import { test } from 'node:test'; import assert from 'node:assert/strict';\n" :
      "import { test, expect } from 'vitest';\n";
    const check = (expr) => runner === 'node' ? `assert.ok(${expr});` : `expect(${expr}).toBe(true);`;
    files[`src/cache.${ext}`] = `import { readFileSync } from 'node:fs';\nexport const enabled = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).enabled;\n`;
    for (const [letter, name] of [['a','A'], ['b','B']]) files[`tests/cache-${letter}.test.${ext}`] =
      `${imports}import { enabled } from '../src/cache.${ext}';\ntest('cached ${name}', async () => { const again = await import('../src/cache.${ext}'); ${check('enabled && again.enabled')} });\n`;
    files[`tests/io.test.${ext}`] = `${imports}import * as fs from 'node:fs';
import { readFile as promised } from 'node:fs/promises';
const { readFileSync: captured, createReadStream } = fs;
test('alias async stream probes', async () => {
  ${check(`captured(new URL('../src/text.${ext}', import.meta.url), 'utf8').includes('green')`)}
  ${check(`(await promised(new URL('../config.json', import.meta.url), 'utf8')).includes('true')`)}
  let data = ''; for await (const chunk of createReadStream(new URL('../src/text.${ext}', import.meta.url))) data += chunk;
  ${check("data.includes('green')")}
  ${runner === 'node' ? `assert.equal(fs.existsSync(new URL('../src/absent.${ext}', import.meta.url)), false);` : `expect(fs.existsSync(new URL('../src/absent.${ext}', import.meta.url))).toBe(false);`}
  try { fs.statSync(new URL('../src/absent.${ext}', import.meta.url)); } catch (error) { ${check("error.code === 'ENOENT'")} }
  ${check("fs.readdirSync(new URL('../src', import.meta.url)).includes('text." + ext + "')")}
});
`;
  }
  writeFiles(root, files);
  return { files, testFiles:[`tests/text.test.${ext}`, `tests/text-runtime.test.${ext}`,
    `tests/cache-a.test.${ext}`, `tests/cache-b.test.${ext}`, `tests/io.test.${ext}`] };
}
