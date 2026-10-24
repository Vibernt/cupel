import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli/main.mjs';
import { requireCollector } from '../src/cli/collect.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const sample = readFileSync(join(repo, 'spec/conformance/cases/001-report-minimal/input.json'), 'utf8');

test('each named collector wins over node test discovery', async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/runners-'));
  try {
    writeFileSync(join(root, 'sample.test.mjs'), "import { test } from 'node:test'; test('node', () => {});\n");
    const stub = join(root, 'collector.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[process.argv.indexOf('--out') + 1], ${JSON.stringify(sample)});
`);
    for (const name of ['node', 'vitest', 'pytest', 'go', 'minitest', 'cargo', 'dotnet', 'custom']) {
      const cfg = { runners: { [name]: { collector: `"${process.execPath}" "${stub}"` } } };
      const collector = await requireCollector(process.env, root, cfg);
      const input = await collector.collectNode({ root, runs: 1 });
      assert.deepEqual(input, JSON.parse(sample), name);
    }
    writeFileSync(join(root, 'vite.config.mjs'), 'export default { test: {} };\n');
    assert.equal((await requireCollector(process.env, root, { runners: { node: {} } })).kind, undefined);
    assert.equal((await requireCollector(process.env, root, { runners: { vitest: {} } })).kind, 'vitest');
    assert.equal(typeof (await requireCollector(process.env, root, { runners: { cargo: {} } })).collectNode, 'function');
    await assert.rejects(requireCollector(process.env, root, { runners: { dotnet: {} } }), /runner dotnet needs a collector command/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('several configured runners merge into one valid input', async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/multiple-runners-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
    const input = JSON.parse(sample);
    const stub = join(root, 'collector.mjs');
    writeFileSync(stub, `import { writeFileSync } from 'node:fs';
const name = process.argv[2];
const input = ${JSON.stringify(input)};
input.tests = input.tests.map(t => ({...t, id: name + '/' + t.id}));
input.coverage.byTest = Object.fromEntries(Object.entries(input.coverage.byTest ?? {}).map(([id, value]) => [name + '/' + id, value]));
writeFileSync(process.argv[process.argv.indexOf('--out') + 1], JSON.stringify(input));
`);
    writeFileSync(join(root, 'cupel.json'), JSON.stringify({ runners: {
      alpha: { collector: `"${process.execPath}" "${stub}" alpha` },
      beta: { collector: `"${process.execPath}" "${stub}" beta` },
    } }));
    const out = join(root, 'input.json');
    const exit = await main(['label', '--runs', '1', '--out', out], { cwd: root, env: process.env, colour: false, out: () => {}, err: () => {} });
    assert.equal(exit, 0);
    const merged = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(merged.runtimes.map(r => r.runner), ['alpha', 'beta']);
    assert.deepEqual([...new Set(merged.tests.map(t => t.runner))], ['alpha', 'beta']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
