# Cupel docs

User documentation goes here as features land. That includes the config file, tiers, MCP setup for Claude Code, Cursor and Codex, and [extending Cupel](extending/README.md).

- [CLI reference](cli.md): commands, options, exit codes, JUnit import and validation.
- [Local MCP server](mcp.md): agent tools and Claude Code, Cursor and Codex setup.

## Cleaning up tests with an agent

Run `cupel review --json` or call `cupel_review` to get a bounded evidence pack. Read the named test code and assertions, propose a change, then run `cupel guard --base HEAD` or `cupel_guard` before committing. The pack does not decide which tests to change. `no-unique-evidence` cannot establish that a test is redundant.
