#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [rustc, ...originalArgs] = process.argv.slice(2);
const source = process.env.CUPEL_PROOF_SOURCE;
const mutant = process.env.CUPEL_PROOF_MUTANT;
if (!rustc || !source || !mutant) {
  process.stderr.write('proof wrapper requires rustc, source, and mutant paths\n');
  process.exit(2);
}

const args = originalArgs.map((arg) => arg === 'src/lib.rs' || arg === source ? mutant : arg);
if (args.includes(mutant)) args.push(`--remap-path-prefix=${mutant}=${source}`);
const result = spawnSync(rustc, args, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
