// Whole-result oracle for the pre-edit engine. The baseline source and input corpus
// are frozen under ignored .scratch/engine-flow before production edits.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate } from '../../../../packages/cupel/src/engine/schema.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const scratch = join(root, '.scratch/engine-flow');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const schemas = Object.fromEntries(['input', 'config', 'report'].map(name =>
  [name, read(join(root, `spec/schemas/${name}.schema.json`))]));

function generated(count, { fileLevel = false, unknownTag = false, unicode = false } = {}) {
  const source = unicode ? 'src/éclair.mjs' : 'src/work.mjs';
  const tests = [];
  const byTest = {};
  const byFile = {};
  const shapes = {};
  for (let i = 0; i < count; i++) {
    const id = `test-${String(i).padStart(5, '0')}`;
    const file = `tests/${unicode ? 'école-' : ''}${i % 19}.test.mjs`;
    tests.push({ id, file, name: id, status: i % 23 === 0 ? 'failed' : 'passed',
      durationsMs: [i % 31, i % 31 + 1], ...(i % 13 === 0 ? { tags: [unknownTag ? 'custom' : 'critical'] } : {}) });
    byTest[id] = { [source]: `${i % 97 + 1}-${i % 97 + 3}` };
    byFile[file] = { [source]: `${i % 97 + 1}-${i % 97 + 3}` };
    shapes[id] = [i % 7, 10 + i % 3];
  }
  return { spec: 'cupel-spec/1', kind: 'input', runtime: { name: 'node', version: '22.0.0' },
    sources: { [source]: { coverable: '1-100' } }, tests,
    coverage: fileLevel ? { granularity: 'file', byFile } :
      { granularity: 'test', byTest, rechecked: tests.map(t => t.id) }, shapes };
}

function corpus() {
  const cases = [];
  const dir = join(root, 'spec/conformance/cases');
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const entry = read(join(path, 'case.json'));
    const files = readdirSync(path);
    const inputs = files.includes('base.json') ? { base: read(join(path, 'base.json')),
      head: read(join(path, 'head.json')) } : { input: read(join(path, 'input.json')) };
    if (files.includes('assertions.json')) inputs.assertions = read(join(path, 'assertions.json'));
    cases.push({ name, command: entry.command, inputs,
      config: files.includes('config.json') ? read(join(path, 'config.json')) : {}, args: entry.args ?? {} });
  }
  for (const [count, options] of [
    [3, {}], [24, {}], [70, { unicode: true }], [130, { unknownTag: true }],
    [75, { fileLevel: true }],
  ]) {
    const input = generated(count, options);
    const problems = validate(schemas.input, input);
    if (problems.length) throw new Error(`generated ${count}: ${JSON.stringify(problems)}`);
    const suffix = `${count}-${Object.keys(options)[0] ?? 'regular'}`;
    for (const command of ['report', 'label', 'validate', 'plan', 'review', 'check', 'guard']) {
      const inputs = command === 'guard' || command === 'check' ? { base: input, head: input } : { input };
      const args = command === 'check' ? { tests: input.tests.slice(0, 4).map(t => t.id) } :
        command === 'review' ? { units: input.tests.slice(0, 2).map(t => t.id) } : {};
      cases.push({ name: `generated-${suffix}-${command}`, command, inputs, config: {}, args });
    }
  }
  const actual = join(root, '.scratch/s12b/real-lane/collector-input.json');
  const input = read(actual);
  if (input.tests.length !== 65) throw new Error('real input no longer has 65 tests');
  for (const command of ['report', 'validate', 'label', 'plan', 'review', 'check', 'guard']) {
    cases.push({ name: `actual-65-${command}`, command,
      inputs: command === 'guard' || command === 'check' ? { base: input, head: input } : { input },
      config: {}, args: command === 'check' ? { tests: input.tests.slice(0, 4).map(t => t.id) } : {} });
  }
  return cases;
}

async function results(enginePath, entries) {
  const { run } = await import(pathToFileURL(enginePath));
  return entries.map(entry => ({ name: entry.name,
    result: run(entry.command, entry.inputs, entry.config, entry.args, schemas) }));
}

const mode = process.argv[2];
if (mode === 'capture') {
  const entries = corpus();
  writeFileSync(join(scratch, 'corpus.json'), JSON.stringify(entries));
  writeFileSync(join(scratch, 'baseline-results.json'), JSON.stringify(await results(
    join(scratch, 'baseline/src/engine/index.mjs'), entries)));
  console.log(`captured ${entries.length} full report and exit results`);
} else if (mode === 'compare') {
  const entries = read(join(scratch, 'corpus.json'));
  const expected = read(join(scratch, 'baseline-results.json'));
  const observed = await results(join(root, 'packages/cupel/src/engine/index.mjs'), entries);
  if (observed.length !== expected.length) throw new Error('oracle length changed');
  const differing = observed.flatMap((entry, i) =>
    JSON.stringify(entry) === JSON.stringify(expected[i]) ? [] : [entry.name]);
  if (differing.length) throw new Error(`${differing.length} full results changed: ${differing.join(', ')}`);
  console.log(`exact full report and exit parity: ${observed.length}/${expected.length}`);
} else throw new Error('usage: differential.mjs capture|compare');
