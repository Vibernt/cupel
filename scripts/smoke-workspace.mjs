import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

// Each package smoke owns one new directory. Earlier artifacts remain available
// for inspection, including a failed run's partial results.
export function createSmokeWorkspace(root) {
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'run-'));
}
