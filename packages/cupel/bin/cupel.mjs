#!/usr/bin/env node
// cupel: CLI commands and the local MCP stdio server. See docs/cli.md and docs/mcp.md.
import { main } from '../src/cli/main.mjs';

const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  colour,
});
