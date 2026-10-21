#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { EXIT, SPEC_VERSION } from '../src/index.mjs';

const COMMANDS = ['report', 'check', 'guard', 'plan', 'label', 'mcp'];

const HELP = `cupel: keep only the tests worth running (${SPEC_VERSION})

Usage: cupel <command> [options]

Commands (not implemented yet):
  report   score every test and give advice
  check    does a new or changed test add anything?
  guard    fail if coverage or critical mutation score falls
  plan     priority order for a run
  label    show and check tiers
  mcp      start the local MCP server (stdio)

Options:
  --help     show this help
  --version  show the version
`;

function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function main(argv) {
  const [cmd] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return cmd ? EXIT.OK : EXIT.USAGE;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${version()}\n`);
    return EXIT.OK;
  }
  if (COMMANDS.includes(cmd)) {
    process.stderr.write(`cupel ${cmd}: not implemented yet\n`);
    return EXIT.USAGE;
  }
  process.stderr.write(`cupel: unknown command "${cmd}" (see cupel --help)\n`);
  return EXIT.USAGE;
}

process.exitCode = main(process.argv.slice(2));
