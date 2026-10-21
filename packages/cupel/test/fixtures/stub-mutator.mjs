// Test-only stand-in for src/mutate (used through CUPEL_TEST_MUTATOR with NODE_ENV=test).
// Returns the mutants in <root>/stub-mutation.json, with `targeted` set to the scope's targeted units.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export async function mutateNode({ root, config, scope }) {
  if (process.env.CUPEL_STUB_LOG) appendFileSync(process.env.CUPEL_STUB_LOG, `${JSON.stringify({ call: 'mutateNode', root, scope })}\n`);
  const mutants = JSON.parse(readFileSync(join(root, 'stub-mutation.json'), 'utf8'));
  return { mutants, targeted: scope.targeted, seed: config.mutation.seed, sampled: false };
}
