# Local MCP server

The [support matrix](support.md) defines **JS/TS/Python core full guard**,
**bounded Go/Ruby/Rust preview**, and **private experimental selective PR**
commands outside the supported first release. Exact runtime limits and pending
acceptance gates apply equally to source and installed entry points.

`cupel mcp` starts a local Model Context Protocol server over stdio. It reads one JSON-RPC 2.0 message per line on stdin, writes one JSON response per line on stdout, and sends diagnostics only to stderr. Cupel's shipped server makes no network or model calls and installs no dependencies. Tools can execute the target project's tests and configured commands, which retain their own side effects. Cupel never advises removing tests: `no-unique-evidence` means a person may review, never "delete".

The server supports protocol versions `2025-06-18` and `2025-03-26`. Start it with `--root /path/to/repo` to select the repository being assessed. Without `--root`, it uses the git root of the current directory. File paths in tool arguments are resolved from that root; a `config` path overrides its `cupel.json`.

## Tools

| Tool | When an agent should call it | Inputs |
|---|---|---|
| `cupel_check` | Before committing new or changed tests: review their evidence. | `tests` (test IDs or files), `input` or `headInput`, optional `baseInput` or git `base`, `config` |
| `cupel_review` | Before deleting or merging tests: inspect the evidence pack, then read the test code and run `cupel_guard` on a proposed change. | `input`, `config`, `units` (unit IDs, row IDs or test files), `limit` (default 50), `assertions` (S10b sidecar path) |
| `cupel_guard` | Before removing or rewriting tests: did the change lose coverage, mutation evidence or protection? | `baseInput` and `headInput` (or `input` for the head), git `base`, `approvals`, `config` |
| `cupel_plan` | Choose which tests to run first. | `input`, git `changed`, `config` |
| `cupel_report` | See the whole-suite picture. Optionally retain one completed report to replay other pages. | `input`, `config`, `page`, `pageSize`, `retain`, `snapshotId` |
| `cupel_label` | See each unit's tier and reason. | `input`, `config`, `page`, `pageSize` |

Omit file inputs to collect the working tree through the same code path as the CLI. Without `tests`, `cupel_check` checks every collected unit. Without a base, `cupel_guard` compares `HEAD` with the working tree. `approvals` can be a JSON file path or a list of `{ "action": "remove" | "downgrade", "id": "...", "by": "..." }` supplied by a person. Cupel does not create approvals.

Each result has a one-line summary and compact JSON in two text content items. A check or guard failure is a normal tool result (`isError: false`); the JSON contains the engine report. Usage and environment failures set `isError: true`. `cupel_report` and `cupel_label` page `units` by default at 50 per page, at most 200, and return `{ suite, units, groups, page, pages }`. Other tool JSON is the full engine report.

### Replaying pages of one report

An ordinary `cupel_report` call is always fresh. Pass `retain: true` on a normal call to run the full report once and save its complete result in this MCP process. The JSON text content then adds `snapshotId` and `snapshot: { "kind": "report", "replay": false, "historical": true }` beside the usual paged fields. For another page of that same result, call `cupel_report` with only `snapshotId` and optional `page` and `pageSize`. Replay adds the same metadata with `replay: true`; the summary says it is historical. Page content is taken from the retained complete report, so a different page size is allowed without collection or mutation work.

A replay is a saved **report output**, not fresh evidence. It cannot be used as an input for `cupel_check`, `cupel_guard`, `cupel_plan`, or another tool. In particular, a replay says nothing about whether the working tree is still safe; run a fresh guard for that decision. Replay rejects `input`, `config`, `retain` (including `false`) and every other execution argument. `cupel_label` and all other tools reject `retain` and `snapshotId`.

Snapshots live only in the server process and are bound to its git root. The cache holds at most eight complete reports and 32 MiB of serialized UTF-8 snapshot data in total, evicting the least recently used entry when either limit is reached. A report larger than the byte limit returns an explicit tool error instead of a handle. Usage and environment failures are never retained. A malformed, missing, evicted, corrupt or wrong-root handle returns an explicit error and does not collect again; call `cupel_report` without `snapshotId` to request a fresh report. Restarting the MCP server loses its snapshots. No snapshot is written to disk or shared across roots.

## Cleaning up tests with an agent

Call `cupel_review` once for the candidate pack. Read each named test and its assertions, then propose and make the change. Run `cupel_guard` against the base before committing; its failure must be resolved or handled through the existing human approval process. Cupel never advises removal. A missing assertion sidecar leaves assertion observations absent; merged inputs accept the multi-runner sidecar from `cupel assertions`. A pseudo-test reason needs function-scope `body-replace` results and matching `functionSites` in the input; ordinary collection omits it.

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

## Private experimental selective PR tools

Outside the supported first release, `cupel_pr_producer`, `cupel_pr_prepare` and
`cupel_pr` retain the private experimental Node 26.7.0 selective profile. They return distinct scoped data and require
independently trusted pins; they never claim a whole-suite guard pass. See
[selective PR checks](selective-pr.md) for the exact preparation and request
contract. Node 22 selective execution refuses.
