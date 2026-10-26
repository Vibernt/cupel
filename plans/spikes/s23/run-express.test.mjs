import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoExcludedObservations, runExpress } from './run-express.mjs';

const scratch = fileURLToPath(new URL('../../../.scratch/s23/', import.meta.url));

test('real-lane acceptance refuses missing externally supplied producer pin', () => {
  assert.throws(() => runExpress('/unused/derivation.json', undefined), /external producer hash pin/);
  assert.throws(() => runExpress('/unused/derivation.json', 'sha256:bad'),
    /external producer hash pin/);
});

test('real-lane trace gate catches an excluded TSX runtime observation', () => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'trace-gate-'));
  try {
    const path = join(root, 'events.jsonl');
    writeFileSync(path, `${JSON.stringify({ kind: 'file', file: 'src/plugins/safe.mjs' })}\n`);
    assert.deepEqual(assertNoExcludedObservations(root),
      { traceFiles: 1, rowsChecked: 1, excludedEvents: 0 });
    writeFileSync(path, `${JSON.stringify({ kind: 'file', channel: 'imports',
      file: 'src/components/patterns/Searchbox/Chat.tsx' })}\n`);
    assert.throws(() => assertNoExcludedObservations(root), /excluded TSX file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
