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
    await assert.rejects(requireCollector(process.env, root, { runners: { cargo: {} } }), /runner cargo needs a collector command/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('several configured runners are a usage error', async () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/multiple-runners-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
    writeFileSync(join(root, 'cupel.json'), '{"runners":{"node":{},"go":{}}}');
    let error = '';
    const exit = await main(['label'], { cwd: root, env: process.env, colour: false,
      out: () => {}, err: (line) => { error += line; } });
    assert.equal(exit, 2);
    assert.match(error, /multiple runners configured \(node, go\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
