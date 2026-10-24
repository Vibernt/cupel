// Offline comparison against a pinned baseline. All generated artifacts are ignored.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { generate } from './generate.mjs';

const dir = resolve('.scratch/s11');
const root = generate(join(dir, 'module'));
process.env.GOCACHE = join(dir, 'cache');
process.env.GOPROXY = 'off'; process.env.GOSUMDB = 'off'; process.env.GOTOOLCHAIN = 'local';
const baseline = process.argv[2] ?? 'a7c7180a36b254e51aa63c2ad922f4e02f8d57bc';
const sourceDir = 'packages/cupel/src/collect/go';
const replace = (text, a, b) => { assert.ok(text.includes(a), `instrumentation target missing: ${a}`); return text.replace(a, b); };
async function collector(label, revision) {
  const copy = join(dir, `measured-${label}`); mkdirSync(copy, { recursive: true });
  for (const file of ['index.mjs', 'process.mjs', 'coverage.mjs', 'tests.mjs', 'lex.mjs', 'test-globs.mjs']) {
    let text;
    if (revision) {
      const result = spawnSync('git', ['show', `${revision}:${sourceDir}/${file}`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); text = result.stdout;
    } else text = readFileSync(join(sourceDir, file), 'utf8');
    if (file === 'test-globs.mjs') text = text.replace('../../engine/match.mjs', pathToFileURL(resolve('packages/cupel/src/engine/match.mjs')).href);
    if (file === 'process.mjs') {
      text = replace(text, 'const child = spawn', 'const start = performance.now(); const child = spawn');
      text = replace(text, "child.on('close', (status) => {", "child.on('close', (status) => { metrics.push({command,args,ms:performance.now()-start});");
      text += '\nexport const metrics = [];\n';
    }
    if (file === 'coverage.mjs') {
      for (const name of ['profile', 'subtract']) {
        text = replace(text, `export function ${name}(`, `function original_${name}(`);
        text += `\nexport function ${name}(...args) { const start=performance.now(); const out=original_${name}(...args); costs.${name}+=performance.now()-start; return out; }\n`;
      }
      text += '\nexport const costs = {profile:0,subtract:0};\n';
    }
    writeFileSync(join(copy, file), text);
  }
  return {
    collect: (await import(pathToFileURL(join(copy, 'index.mjs')))).collectGo,
    process: await import(pathToFileURL(join(copy, 'process.mjs'))),
    coverage: await import(pathToFileURL(join(copy, 'coverage.mjs'))),
  };
}
const old = await collector('before', baseline); const next = await collector('after');
const env = old.process.goEnvironment(root);
await old.process.execute('go', ['test', '-count=1', './...'], { root, env });
const results = {};
for (const [label, c] of [['before', old], ['after', next]]) {
  const s = performance.now(); await c.process.execute('go', ['test', '-count=1', './...'], { root, env });
  const plainMs = performance.now() - s; c.process.metrics.length = 0;
  const start = performance.now(); const input = await c.collect({ root, runs: 2 });
  results[label] = { plainMs, wallMs: performance.now() - start, costs: c.coverage.costs, metrics: c.process.metrics };
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(input));
  writeFileSync(join(dir, `${label}-metrics.json`), JSON.stringify(results[label], null, 2));
  console.log(label, { plainMs, wallMs: results[label].wallMs, costs: c.coverage.costs });
}
const normalize = (label) => {
  const input = JSON.parse(readFileSync(join(dir, `${label}.json`)));
  for (const test of input.tests) delete test.durationsMs;
  return input;
};
assert.deepEqual(normalize('after'), normalize('before'));
writeFileSync(join(dir, 'parity.json'), JSON.stringify({ baseline, tests: normalize('before').tests.length, fullInputParityExceptDurations: true }, null, 2));
console.log('Full input parity, excluding durations: PASS');
