#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [rustc, ...original] = process.argv.slice(2);
const root = process.env.CUPEL_GRAPH_ROOT;
const scratch = process.env.CUPEL_GRAPH_SCRATCH;
const log = process.env.CUPEL_GRAPH_LOG;
if (!rustc || !root || !scratch || !log) {
  process.stderr.write('S25 wrapper requires rustc and explicit graph paths\n');
  process.exit(2);
}

const originalRoot = `${root}/src/lib.rs`;
const scratchRoot = `${scratch}/lib-mutant.rs`;
let substituted = false;
const args = original.map((arg) => {
  if (arg !== 'src/lib.rs' && arg !== originalRoot) return arg;
  substituted = true;
  return scratchRoot;
});
if (substituted) {
  const mappings = [
    [scratchRoot, 'src/lib.rs'],
    [`${scratch}/outer-mutant.rs`, 'src/outer.rs'],
    [`${scratch}/outer/inner-mutant.rs`, 'src/outer/inner.rs'],
  ];
  for (const [from, to] of mappings) args.push(`--remap-path-prefix=${from}=${to}`);
  appendFileSync(log, JSON.stringify({ crateRoot: original.find((arg) => arg === 'src/lib.rs' || arg === originalRoot),
    replacement: scratchRoot, remaps: mappings }) + '\n');
}
const result = spawnSync(rustc, args, { stdio: 'inherit', timeout: 120_000 });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
