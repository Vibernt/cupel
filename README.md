# Cupel

**Keep only the tests worth running.**

> Status: **pre-release, private.** Nothing here is published yet. Interfaces will change.

A cupel is the dish assayers use in cupellation: the base metal is drawn off and the precious metal stays. Cupel draws off the tests that add nothing and keeps the ones that matter.

Coding agents now write most new tests, and suites grow faster than anyone reviews them. Cupel is an open-source, local-first tool for people and coding agents that:

- **Measures** each test's worth: unique coverage, unique mutation kills, redundancy, cost and brittleness.
- **Labels** tests `critical`, `standard` or `minor`, using path rules and in-test tags.
- **Advises** keep, consolidate, rewrite or retire, with the evidence for each.
- **Guards** every change that removes or rewrites tests: coverage never falls, the mutation score on critical code never falls, and no critical test is removed without a person's approval.
- **Prioritises** runs: critical tests first, then tests affected by the change, then the rest.

It ships as a CLI (`cupel`), a local MCP server (stdio) and a GitHub Action.

It has no UI, no hosted service, no analytics, no telemetry and no model calls. It is deterministic: the same inputs always give the same report.

## Planned commands

| Command | Does |
|---|---|
| `cupel report` | Scores every test and gives advice |
| `cupel check <tests>` | Says whether a new or changed test adds anything |
| `cupel guard --base <ref>` | Fails if coverage or the critical mutation score falls, or a critical test is removed |
| `cupel plan` | Gives the order to run tests in |
| `cupel label` | Shows and checks tiers |
| `cupel mcp` | Starts the local MCP server |

All commands take `--json`. Exit codes: `0` ok, `1` guardrail or check failed, `2` usage error, `3` environment error.

## Layout

```
spec/               the spec (cupel-spec/1) and conformance cases
packages/cupel/     JS engine, collectors, CLI and MCP server (Node 22+)
packages/cupel-py/  pytest collector, later the Python engine
action/             the GitHub Action
docs/               user docs
plans/              product, architecture, spikes, roadmap and decisions
```

## Licence

[Apache-2.0](LICENSE).
