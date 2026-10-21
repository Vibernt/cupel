#!/usr/bin/env node
// cupel: keep only the tests worth running. See docs/cli.md.
import { main } from '../src/cli/main.mjs';

const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  colour,
});
