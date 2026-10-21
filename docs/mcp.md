# Local MCP server

`cupel mcp` starts a local Model Context Protocol server over stdio. It reads one JSON-RPC 2.0 message per line on stdin, writes one JSON response per line on stdout, and sends diagnostics only to stderr. It does not use the network, install a dependency, delete tests, or make model calls. Retire advice requires a person's approval.

The server supports protocol versions `2025-06-18` and `2025-03-26`. Start it with `--root /path/to/repo` to select the repository being assessed. Without `--root`, it uses the git root of the current directory. File paths in tool arguments are resolved from that root; a `config` path overrides its `cupel.json`.

## Tools

| Tool | When an agent should call it | Inputs |
|---|---|---|
| `cupel_check` | Before committing new or changed tests: does this test add anything? | `tests` (test IDs or files), `input` or `headInput`, optional `baseInput` or git `base`, `config` |
| `cupel_guard` | Before removing or rewriting tests: did the change lose coverage, mutation evidence or protection? | `baseInput` and `headInput` (or `input` for the head), git `base`, `approvals`, `config` |
| `cupel_plan` | Choose which tests to run first. | `input`, git `changed`, `config` |
| `cupel_report` | See the whole-suite picture. | `input`, `config`, `page`, `pageSize` |
| `cupel_label` | See each unit's tier and reason. | `input`, `config`, `page`, `pageSize` |

Omit file inputs to collect the working tree through the same code path as the CLI. Without `tests`, `cupel_check` checks every collected unit. Without a base, `cupel_guard` compares `HEAD` with the working tree. `approvals` can be a JSON file path or a list of `{ "action": "remove" | "downgrade", "id": "...", "by": "..." }` supplied by a person. Cupel does not create approvals.

Each result has a one-line summary and compact JSON in two text content items. A check or guard failure is a normal tool result (`isError: false`); the JSON contains the engine report. Usage and environment failures set `isError: true`. `cupel_report` and `cupel_label` page `units` by default at 50 per page, at most 200, and return `{ suite, units, groups, page, pages }`. Other tool JSON is the full engine report.

## Claude Code

```sh
claude mcp add cupel -- node /path/to/packages/cupel/bin/cupel.mjs mcp --root /path/to/repo
```

## Cursor

Put this in `.cursor/mcp.json` for the project:

```json
{
  "mcpServers": {
    "cupel": {
      "command": "node",
      "args": ["/path/to/packages/cupel/bin/cupel.mjs", "mcp", "--root", "/path/to/repo"]
    }
  }
}
```

## Codex CLI

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.cupel]
command = "node"
args = ["/path/to/packages/cupel/bin/cupel.mjs", "mcp", "--root", "/path/to/repo"]
```

The package is private and is not published to npm. Use the local `node /path/to/packages/cupel/bin/cupel.mjs mcp` entry point in these configurations.

### Codex in non-interactive mode

`codex exec` cannot ask you to approve tool calls, so by default it refuses them ("MCP approval required"). Pass `--approve-for-me` to route each approval to Codex's automatic reviewer instead. This was verified with Codex CLI 0.163: an agent called `cupel_check` and `cupel_guard` and reported the same verdicts as the conformance cases.
