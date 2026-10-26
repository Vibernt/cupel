import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFor } from './runtime.mjs';
import { capturedError } from './baseline.mjs';

export function parseJson(result, label) {
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${label} did not produce JSON (exit ${result.exitCode}): ${capturedError(result)}`); }
}

export function inputAt(repo, path = join(repo.dir, '.cupel', 'input.json')) {
  if (!existsSync(path)) throw new Error(`Cupel input is missing: ${path}`);
  const input = JSON.parse(readFileSync(path, 'utf8'));
  if (!input.tests?.length) throw new Error('Cupel collected zero tests; collector selection must be fixed');
  // The input names the runtime, not the runner: Vitest and node:test report node, pytest reports python.
  const want = runtimeFor[repo.runner];
  if (want && input.runtime?.name !== want) throw new Error(`expected a ${want} runtime from the ${repo.runner} collector, got ${input.runtime?.name ?? 'unknown'}`);
  return input;
}

export const reportOptions = (out = '/work/.cupel/input.json', mutation = true) =>
  `--config /work/.cupel-bench.json --json --runs 2 ${mutation ? '' : '--no-mutation '}--out ${out}`;
