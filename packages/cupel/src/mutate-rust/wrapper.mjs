#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [compiler,...original] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(process.env.CUPEL_RUST_WRAPPER_SPEC,'utf8'));
if (compiler !== spec.compiler) { process.stderr.write('unexpected Rust compiler identity\n'); process.exit(2); }
const roots = original.filter((arg) => arg === 'src/lib.rs' || arg === `${spec.project}/src/lib.rs`);
let args = [...original];
if (roots.length) {
  if (roots.length !== 1 || !original.includes('--crate-name') || !original.includes('--edition=2021') && !original.includes('--edition=2024')) process.exit(2);
  args = args.map((arg) => arg === roots[0] ? spec.graph.root : arg);
  for (const [from,to] of spec.graph.mappings) args.push(`--remap-path-prefix=${from}=${to}`);
  appendFileSync(spec.log,JSON.stringify({ compiler, original, args, root:roots[0], test:original.includes('--test') })+'\n');
}
const result = spawnSync(compiler,args,{stdio:'inherit'});
if (result.error) { process.stderr.write(`${result.error.message}\n`); process.exit(2); }
if (result.signal) { process.kill(process.pid,result.signal); }
process.exit(result.status ?? 2);
