// Local, opt-in performance measurement. No benchmark code is imported by Cupel.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { validate } from '../../../../packages/cupel/src/engine/schema.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const scratch = join(root, '.scratch/engine-flow');
const actualPath = join(root, '.scratch/s12b/real-lane/collector-input.json');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map(name =>
  [name, read(join(root, `spec/schemas/${name}.schema.json`))]));
const actual = read(actualPath);
if (actual.tests.length !== 65) throw new Error('actual input is not the recorded 65-row input');

function synthetic() {
  const sources = {};
  const tests = [];
  const byTest = {};
  const shapes = {};
  for (let f = 0; f < 100; f++) {
    const source = `src/source-${f}.mjs`;
    const file = `tests/file-${f}.test.mjs`;
    sources[source] = { coverable: '1-100' };
    for (let n = 0; n < 100; n++) {
      const id = `unit-${String(f).padStart(3, '0')}-${String(n).padStart(3, '0')}`;
      tests.push({ id, file, name: id, status: 'passed', durationsMs: [1, 2] });
      byTest[id] = { [source]: '1-3' };
      shapes[id] = [1, 2];
    }
  }
  return { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '22.0.0' },
    sources, tests, coverage: { granularity: 'test', byTest }, shapes };
}

const large = synthetic();
const errors = validate(schemas.input, large);
if (errors.length) throw new Error(`synthetic input invalid: ${JSON.stringify(errors)}`);
const largePath = join(scratch, 'synthetic-10000.json');
writeFileSync(largePath, JSON.stringify(large));

const engine = {
  baseline: (await import(pathToFileURL(join(scratch, 'baseline/src/engine/index.mjs')))).run,
  current: (await import(pathToFileURL(join(root, 'packages/cupel/src/engine/index.mjs')))).run,
};

function invoke(run, command, doc) {
  const inputs = command === 'guard' ? { base: doc, head: doc } : { input: doc };
  return run(command, inputs, {}, {}, schemas);
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function enginePairs(command, doc) {
  for (const run of Object.values(engine)) invoke(run, command, doc);
  const pairs = [];
  for (let i = 0; i < 5; i++) {
    const pair = {};
    for (const name of i % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
      const start = performance.now();
      const result = invoke(engine[name], command, doc);
      pair[name] = { ms: performance.now() - start, result };
    }
    if (JSON.stringify(pair.baseline.result) !== JSON.stringify(pair.current.result))
      throw new Error(`whole-result mismatch in ${command} pair ${i}`);
    pairs.push({ baselineMs: pair.baseline.ms, currentMs: pair.current.ms });
  }
  return { pairs, baselineMedianMs: median(pairs.map(p => p.baselineMs)),
    currentMedianMs: median(pairs.map(p => p.currentMs)) };
}

function cli(bin, command) {
  const args = command === 'guard'
    ? ['guard', '--base-input', actualPath, '--head-input', actualPath, '--json', '--quiet']
    : [command, '--input', actualPath, '--json', '--quiet'];
  const start = performance.now();
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 8 * 1024 * 1024 });
  const ms = performance.now() - start;
  if (result.error || result.status !== 0) throw new Error(`${command} CLI: ${result.error ?? result.stderr}`);
  return { ms, stdout: result.stdout };
}

function cliPairs(command) {
  const bins = { baseline: join(scratch, 'baseline-cli/bin/cupel.mjs'),
    current: join(root, 'packages/cupel/bin/cupel.mjs') };
  for (const bin of Object.values(bins)) cli(bin, command);
  const pairs = [];
  for (let i = 0; i < 5; i++) {
    const pair = {};
    for (const name of i % 2 ? ['current', 'baseline'] : ['baseline', 'current']) pair[name] = cli(bins[name], command);
    if (pair.baseline.stdout !== pair.current.stdout) throw new Error(`CLI output mismatch in ${command} pair ${i}`);
    pairs.push({ baselineMs: pair.baseline.ms, currentMs: pair.current.ms });
  }
  return { pairs, baselineMedianMs: median(pairs.map(p => p.baselineMs)),
    currentMedianMs: median(pairs.map(p => p.currentMs)) };
}

const measurements = {
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  input: { actualRows: actual.tests.length, syntheticRows: large.tests.length,
    syntheticFiles: new Set(large.tests.map(t => t.file)).size },
  engineOnly: {
    actualReport: enginePairs('report', actual),
    actualGuard: enginePairs('guard', actual),
    actualValidate: enginePairs('validate', actual),
    syntheticReport: enginePairs('report', large),
  },
  fullCli: { actualReport: cliPairs('report'), actualGuard: cliPairs('guard') },
};
writeFileSync(join(scratch, 'measurements.json'), JSON.stringify(measurements, null, 2));
console.log(JSON.stringify(measurements, null, 2));
