import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { duplicateSealed, loadSealed, saveJson, seal } from './artifacts.mjs';

test('sealed S16 evidence loads exactly and refuses corruption', t => {
  mkdirSync(resolve('.scratch/s16'), { recursive: true });
  const dir = mkdtempSync(resolve('.scratch/s16/artifact-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  saveJson(dir, 'bundle.json', { proof: 'pinned' });
  saveJson(dir, 'args.json', { files: 4 });
  seal(dir, ['bundle.json', 'args.json']);
  assert.deepEqual(loadSealed(dir)['bundle.json'], { proof: 'pinned' });
  const copy = `${dir}-copy`;
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  assert.equal(duplicateSealed(dir, copy), 2);
  assert.deepEqual(loadSealed(copy)['args.json'], { files: 4 });
  assert.throws(() => duplicateSealed(dir, copy), /must be new/);
  writeFileSync(join(dir, 'bundle.json'), '{}\n');
  assert.throws(() => loadSealed(dir), /differs/);
  assert.throws(() => saveJson(dir, '../outside.json', {}), /unsafe/);
});
