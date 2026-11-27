// S30: block coverage rebuilt from never-pausing breakpoints (the only route workerd leaves open)
// must equal V8's own block coverage. Both run on Cupel's engine in Node, which has the same V8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { functionRanges, paintHits, topLevelIntervals, statementBlocks, controlStops } from '../src/collect/node/workerd-ranges.mjs';
import { analyse, coveredLines } from '../src/collect/node/lines.mjs';

const driver = fileURLToPath(new URL('fixtures/workerd-ranges-driver.mjs', import.meta.url));
const measure = (mode) => {
  const r = spawnSync(process.execPath, [driver, mode, '24'], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// One known V8 difference, named by its source text so that any other difference still fails: in the engine's I6
// check, a statement after `continue` that never runs holds a conditional expression inside a template literal. V8
// reports zero-count ranges that end at that `?:`, and the rest of the statement and the loop's closing brace fall in
// the gap, which V8 counts at the parent's count. Breakpoints show those lines never run; the rebuild is right.
const V8_GAP = { file: 'index.mjs', marker: 'these fault results stopped at the first catching test', lines: [0, 1] };

test('breakpoint-rebuilt coverage equals V8 block coverage, line for line, on the engine', { timeout: 400_000 }, () => {
  const precise = measure('precise');
  const rebuilt = measure('breakpoints');
  assert.ok(Object.keys(precise).length >= 10);
  const text = readFileSync(new URL(`../src/engine/${V8_GAP.file}`, import.meta.url), 'utf8').split('\n');
  const at = text.findIndex((line) => line.includes(V8_GAP.marker)) + 1;
  assert.ok(at > 0, 'the known V8 gap statement is still in the engine; update V8_GAP if it moved');
  const gap = new Set(V8_GAP.lines.map((d) => at + d));
  for (const file of Object.keys(precise)) {
    const expected = file === V8_GAP.file ? precise[file].filter((line) => !gap.has(line)) : precise[file];
    assert.deepEqual(rebuilt[file], expected, file);
    // The rebuild never reports a line V8 does not.
    assert.ok(rebuilt[file].every((line) => precise[file].includes(line)), file);
  }
});

test('function, block and branch boundaries', () => {
  const src = 'const f = (x) => x * 2;\nfunction g(a) {\n  if (a) {\n    return 1;\n  } else {\n    return 2;\n  }\n}\nclass C { m() { return 3; } }\n';
  const ranges = functionRanges(src);
  assert.deepEqual(ranges.map((r) => src.slice(r.header, r.end)), ['(x) => x * 2', 'function g(a) {\n  if (a) {\n    return 1;\n  } else {\n    return 2;\n  }\n}', 'm() { return 3; }']);
  assert.deepEqual(statementBlocks(src, ranges).map((b) => src.slice(b.open, b.end)), ['{\n    return 1;\n  }', '{\n    return 2;\n  }']);
  assert.deepEqual(controlStops(src).map((o) => src.slice(o, o + 4)), ['else']);
  const an = analyse(src);
  assert.deepEqual(coveredLines(an, topLevelIntervals(src, ranges)), [1, 9]);
  // g(true): the if, the then-branch and the function's closing brace; never the else-branch.
  const locations = [{ line: 2, column: 2 }, { line: 3, column: 4 }, { line: 3, column: 13 }, { line: 5, column: 4 }, { line: 5, column: 13 }];
  assert.deepEqual(coveredLines(an, paintHits(src, ranges, locations, new Set([0, 1, 2]))), [2, 3, 4, 5, 8]);
});
