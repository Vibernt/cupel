import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'packages/cupel-ruby');
const bundled = join(root, 'packages/cupel/ruby');

function files(dir) {
  const out = [];
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) visit(child);
      else out.push(relative(dir, child));
    }
  };
  visit(dir);
  return out.sort();
}

test('checked-in Ruby npm runtime is an exact bin/lib mirror', () => {
  const expected = ['bin', 'lib'].flatMap((folder) => files(join(source, folder)).map((file) => join(folder, file))).sort();
  assert.deepEqual(files(bundled), expected, 'run node scripts/sync-ruby-runtime.mjs after canonical Ruby edits');
  for (const file of expected) assert.deepEqual(readFileSync(join(bundled, file)), readFileSync(join(source, file)), file);
  const manifest = JSON.parse(readFileSync(join(root, 'packages/cupel/package.json'), 'utf8'));
  assert.ok(manifest.files.includes('ruby'), 'the npm package must include its Ruby runtime');
});
