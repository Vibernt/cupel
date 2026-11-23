// S30: block coverage rebuilt from never-pausing breakpoints (the only route workerd leaves open)
// must equal V8's own block coverage. Both run on Cupel's engine in Node, which has the same V8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { functionRanges, paintHits, topLevelIntervals, statementBlocks, controlStops } from '../src/collect/node/workerd-ranges.mjs';
import { analyse, coveredLines } from '../src/collect/node/lines.mjs';

const driver = fileURLToPath(new URL('fixtures/workerd-ranges-driver.mjs', import.meta.url));
const measure = (mode) => {
  const r = spawnSync(process.execPath, [driver, mode, '24'], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('breakpoint-rebuilt coverage equals V8 block coverage, line for line, on the engine', { timeout: 400_000 }, () => {
  const precise = measure('precise');
  const rebuilt = measure('breakpoints');
  assert.ok(Object.keys(precise).length >= 10);
  for (const file of Object.keys(precise)) assert.deepEqual(rebuilt[file], precise[file], file);
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
