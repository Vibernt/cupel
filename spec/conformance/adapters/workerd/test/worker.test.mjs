// Runs src/worker.mjs in workerd through Miniflare, as many Workers projects do.
// CUPEL_TEST_MINIFLARE names a package.json whose node_modules has miniflare 5.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { Miniflare } = createRequire(process.env.CUPEL_TEST_MINIFLARE)('miniflare');

async function start(t) {
  const contents = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  const mf = new Miniflare({ cf: false, telemetry: { enabled: false }, enableDevRegistry: false,
    workers: [{ config: { name: 'w', compatibilityDate: '2026-10-01', manifest: { mainModule: 'src/worker.mjs', modules: { 'src/worker.mjs': { type: 'esm', contents } } } } }] });
  await mf.ready;
  t.after(() => mf.dispose());
  return mf;
}

test('doubles', async (t) => {
  const mf = await start(t);
  assert.equal(await (await mf.dispatchFetch('http://x/double?n=4')).text(), '8');
});

test('greets', async (t) => {
  const mf = await start(t);
  assert.equal(await (await mf.dispatchFetch('http://x/greet?name=ada')).text(), 'hello ada');
});
