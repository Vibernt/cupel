// Test-only stand-in for src/collect/node (used through CUPEL_TEST_COLLECTOR with NODE_ENV=test).
// Returns <root>/stub-input.json, lists `recheck` units as rechecked, and logs each call as one JSON
// line to CUPEL_STUB_LOG.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export async function collectNode({ root, config, runs, recheck = [] }) {
  const input = JSON.parse(readFileSync(join(root, 'stub-input.json'), 'utf8'));
  if (process.env.CUPEL_STUB_LOG) {
    appendFileSync(process.env.CUPEL_STUB_LOG, `${JSON.stringify({
      call: 'collectNode',
      root,
      prepared: existsSync(join(root, 'prepared.txt')),
      prepare: config.runners?.node?.prepare ?? null,
      seed: config.mutation?.seed ?? null,
      runs,
      recheck,
    })}\n`);
  }
  if (recheck.length) input.coverage.rechecked = [...recheck].sort();
  return input;
}
