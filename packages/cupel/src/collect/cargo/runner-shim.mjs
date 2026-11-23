// Cargo target runner used once per collection: `cargo test ... -- --list` runs
// each test binary through this file, which reports the working directory and
// the variables Cargo added or changed for that binary, then runs it unchanged.
// The collector then runs every test with exactly that directory and
// environment, on any OS. Values the user already had are never reported: only
// names whose value digest differs from the base digest list are.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = 'CUPEL_CARGO_RUNNER ';
export const BASE = 'CUPEL_CARGO_BASE';

export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function runnerRecord(binary, cwd, environment) {
  const base = JSON.parse(environment[BASE] ?? '{}');
  const added = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name !== BASE && base[name] !== digest(value)) added[name] = value;
  }
  const removed = Object.keys(base).filter((name) => !(name in environment));
  return { binary, cwd, added, removed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [binary, ...args] = process.argv.slice(2);
  const record = runnerRecord(binary, process.cwd(), process.env);
  // One write of one line; Cargo runs test binaries one at a time.
  process.stderr.write(`${MARKER}${Buffer.from(JSON.stringify(record)).toString('base64')}\n`);
  const env = { ...process.env };
  delete env[BASE];
  const result = spawnSync(binary, args, { stdio: 'inherit', env });
  if (result.error) {
    process.stderr.write(`cupel cargo runner: ${result.error.message}\n`);
    process.exit(101);
  }
  process.exit(result.status ?? 101);
}
