// Paired no-profile/profile runs isolate startup/init and profile emission.
// Batched repeat timings bound body + testing-harness cost; they are not pure CPU time.
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execute, goEnvironment, jsonObjects } from '../../packages/cupel/src/collect/go/process.mjs';
import { profile as currentProfile, subtract } from '../../packages/cupel/src/collect/go/coverage.mjs';
import { pathToFileURL } from 'node:url';
const dir = resolve('.scratch/s11'); const root = join(dir, 'module');
const env = { ...goEnvironment(root), GOCACHE: join(dir, 'cache'), GOTOOLCHAIN: 'local' };
const pkgs = jsonObjects((await execute('go', ['list', '-json', './...'], { root, env })).stdout);
const coverpkg = pkgs.map((p) => p.ImportPath).join(',');
const results = [];
const median = (ns) => ns.sort((a, b) => a - b)[Math.floor(ns.length / 2)];
for (const name of ['p00', 'p05', 'p29']) {
  const binary = join(dir, `${name}.test`); const file = join(dir, `${name}.cover`);
  await execute('go', ['test', '-c', '-covermode=count', `-coverpkg=${coverpkg}`, '-o', binary, `./${name}`], { root, env });
  const run = async (args) => { const start = performance.now(); await execute(binary, args, { root, env }); return performance.now() - start; };
  // Warm the executable independently of the paired measurements.
  await run(['-test.run', '^$']);
  const empty = []; const profiled = []; const body = []; const repeated = [];
  for (let i = 0; i < 15; i++) {
    empty.push(await run(['-test.run', '^$']));
    profiled.push(await run(['-test.run', '^$', '-test.coverprofile', file]));
    body.push(await run(['-test.run', '^TestWork3$']));
    repeated.push(await run(['-test.run', '^TestWork3$', '-test.count', '1000']));
  }
  const startupInitMs = median(empty); const emptyProfileMs = median(profiled);
  const oneBodyMs = median(body); const thousandBodiesMs = median(repeated);
  results.push({ name, startupInitMs, emptyProfileMs, profileEmissionEstimateMs: emptyProfileMs - startupInitMs,
    oneBodyMs, thousandBodiesMs, bodyAndHarnessEstimateMs: (thousandBodiesMs - oneBodyMs) / 999 });
}
const { profile: oldProfile } = await import(pathToFileURL(join(dir, 'measured-before/coverage.mjs')));
const parse = {};
for (const [name, fn] of [['before', oldProfile], ['after', currentProfile]]) {
  const cache = new Map(); const file = join(dir, 'p29.cover');
  const setup = fn(file, pkgs, root, cache); const start = performance.now();
  for (let i = 0; i < 2000; i++) subtract(fn(file, pkgs, root, cache), setup);
  parse[name] = performance.now() - start;
}
writeFileSync(join(dir, 'costs.json'), JSON.stringify({ results, parseReplay2000Ms: parse }, null, 2));
console.log({ results, parseReplay2000Ms: parse });
