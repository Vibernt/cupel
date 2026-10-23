import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNode } from '../src/collect/node/index.mjs';
import { collectVitest } from '../src/collect/vitest/index.mjs';
import { readWorkerJson } from '../src/collect/read-json.mjs';
import { writeAtomicJson } from '../src/collect/atomic-json.mjs';
import { main } from '../src/cli/main.mjs';
import { linkVitestModules } from './vitest-modules.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const modules = '/Users/vid/codecrystal/hub-ts/node_modules';

test('truncated result JSON is recorded once, and atomic JSON leaves no temporary file', () => {
  mkdirSync(join(repo, '.scratch'), { recursive: true });
  const root = mkdtempSync(join(repo, '.scratch/truncated-result-'));
  try {
    const file = join(root, 'results.json');
    writeFileSync(file, '{');
    const diagnostics = [], logs = [];
    assert.equal(readWorkerJson(file, diagnostics, (line) => logs.push(line), 'Vitest results'), null);
    assert.equal(readWorkerJson(file, diagnostics, (line) => logs.push(line), 'Vitest results'), null);
    assert.deepEqual(diagnostics.map((item) => item.file), [file]);
    assert.equal(logs.length, 1);
    writeAtomicJson(file, { tests: [] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { tests: [] });
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ['node', 'vitest']) test(`${kind} skips a truncated process hook`,
  { skip: kind === 'vitest' && !existsSync(join(modules, 'vitest/package.json')) }, async () => {
    mkdirSync(join(repo, '.scratch'), { recursive: true });
    const root = mkdtempSync(join(repo, `.scratch/truncated-${kind}-`));
    try {
      mkdirSync(join(root, 'tests'));
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
      writeFileSync(join(root, 'src/value.mjs'), 'export const value = () => 7;\n');
      if (kind === 'vitest') {
        linkVitestModules(root, modules);
        writeFileSync(join(root, 'vitest.config.mjs'), "export default { test: { include: ['tests/*.test.mjs'] } };\n");
      }
      const injected = kind === 'node'
        ? `const cfg = JSON.parse(readFileSync(process.env.CUPEL_NODE_HOOK, 'utf8'));
process.on('exit', () => writeFileSync(join(cfg.out, process.pid + '.json'), '{'));
`
        : `const cfg = JSON.parse(process.env.CUPEL_VITEST_HOOK);
writeFileSync(join(cfg.out, process.pid + '-truncated.json'), '{');
`;
      const source = `import { test${kind === 'vitest' ? ', expect' : ''} } from '${kind === 'node' ? 'node:test' : 'vitest'}';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { value } from '../src/value.mjs';
${injected}
test('covered before truncation', () => { ${kind === 'node' ? 'if (value() !== 7) throw Error()' : 'expect(value()).toBe(7)'}; });
`;
      writeFileSync(join(root, 'tests/value.test.mjs'), source);
      const diagnostics = [], logs = [];
      const input = await (kind === 'node' ? collectNode : collectVitest)({ root, runs: 1,
        config: kind === 'node' ? { runners: { node: { tests: 'tests/*.test.mjs' } } } : {},
        diagnostics, log: (line) => logs.push(line) });
      assert.equal(input.tests.length, 1);
      if (kind === 'node') assert.deepEqual(input.coverage.byTest, {});
      else assert.ok(Object.keys(input.coverage.byTest).length > 0);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0].file, /\.json$/);
      assert.match(diagnostics[0].cause, /JSON|property|end/i);
      assert.equal(logs.filter((line) => line.includes(`skipped ${diagnostics[0].file}`)).length, 1);
      if (kind === 'node') {
        const out = join(root, '.scratch/input.json');
        const exit = await main(['report', '--no-mutation', '--runs', '1', '--out', out], {
          cwd: root, env: process.env, colour: false, out: () => {}, err: () => {},
        });
        assert.equal(exit, 0);
        const sidecar = JSON.parse(readFileSync(join(root, '.scratch/skipped.json'), 'utf8'));
        assert.equal(sidecar.skipped.length, 1);
        assert.match(sidecar.skipped[0].file, /\.json$/);
        assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).coverage.byTest, {});
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
