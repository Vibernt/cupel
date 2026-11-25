import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mutateRuby } from '../src/cli/native-mutation.mjs';

test('native Ruby mutation passes first-catch and catcher history in its scope JSON', (t) => {
  const scratch = resolve('.scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'native-ruby-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.scratch'));
  const stub = join(root, 'collector.mjs');
  writeFileSync(stub, `
    import { copyFileSync, writeFileSync } from 'node:fs';
    const value = (name) => process.argv[process.argv.indexOf(name) + 1];
    copyFileSync(value('--scope'), new URL('./seen-scope.json', import.meta.url));
    writeFileSync(value('--out'), JSON.stringify({ mutants: [], targeted: [] }));
  `);
  const scope = {
    critical: true,
    changed: null,
    targeted: [],
    firstCatch: true,
    catchers: { 'ruby:fault': ['test/a_test.rb::ATest > test_a'] },
  };
  const result = mutateRuby({
    runner: { name: 'minitest', collector: `'${process.execPath}' '${stub}' collect` },
    root,
    cfg: {},
    input: { runtime: { name: 'ruby', version: '4.0.7' } },
    scope,
  });
  assert.deepEqual(result, { mutants: [], targeted: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'seen-scope.json'), 'utf8')), {
    ...scope,
    changed: {},
  });
});
