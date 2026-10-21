# Architecture

## Parts

| Part | What it is |
|---|---|
| **Spec** (`spec/`) | The single source of truth: tier labels and path rules, the value signals and how they combine, the keep/consolidate/rewrite/retire rules, guardrails, the report format (JSON Schema), the config format. Versioned (`cupel-spec/1`) |
| **Conformance cases** (`spec/conformance/`) | Input fixtures (results, coverage, mutation outcomes, config) with the exact expected report. Every implementation must pass all of them |
| **Engine** | Pure, deterministic functions: inputs in, report out. No I/O beyond what is passed in, no clock, no randomness without a seed |
| **Collectors** | Run the user's tests and produce the engine's inputs: per-test results, per-test coverage, changed-line mutation outcomes. One per runner: node:test, Vitest, Jest, pytest first |
| **CLI** (`cupel`) | Commands below; human output by default, `--json` for machines and agents |
| **MCP server** (`cupel mcp`) | Local stdio server exposing the same commands as tools |
| **GitHub Action** | Runs `cupel guard` (and optionally `report`) in CI, posts a job summary, fails on guardrail breaches |

The first implementation is JavaScript (Node 22+, ESM). A Python implementation (the pytest collector and, later, a full engine port) is checked against the same conformance cases.

## CLI commands

| Command | Does | Output |
|---|---|---|
| `cupel report [paths]` | Runs collectors, scores every test, gives advice | Per test: tier, unique coverage (lines, branches), unique kills, redundancy group, cost, brittleness flags, advice with reasons. Suite totals |
| `cupel check <test files or names>` | Does a new or changed test add anything? | Unique coverage and unique kills on the changed code; "adds value", "adds nothing (extend X instead)", or "weakens the suite" |
| `cupel guard --base <ref>` | Compares the suite at a base ref with the working tree | Pass or fail: coverage (line, branch) never falls; critical mutation score never falls; no critical test removed or downgraded without an approval marker; removed tests listed with evidence |
| `cupel plan [--changed <files>]` | Priority order for a run | Critical first, then tests affected by the change (coverage map, naming, imports), then the rest; with expected time |
| `cupel label` | Shows and checks tiers | Tier per test from path rules and tags; refuses unknown tags |
| `cupel mcp` | Starts the MCP server | stdio |

Exit codes are stable and documented: 0 ok, 1 guardrail or check failed, 2 usage error, 3 environment error (a collector could not run).

## MCP tools (local, stdio)

`cupel_check`, `cupel_report` (whole suite or a file), `cupel_guard`, `cupel_plan`, `cupel_label`. Each returns compact JSON plus a one-line summary; long reports are paged. The tool descriptions tell the agent when to call them (before committing new tests: `cupel_check`; before removing tests: `cupel_guard`).

## Value signals (per test)

| Signal | How it is measured | First build? |
|---|---|---|
| Unique coverage | Lines and branches covered by exactly this test (per-test coverage) | Yes (per file first, per test where the runner allows) |
| Unique detection | Mutants on changed or critical code killed by exactly this test | Yes, on critical modules and changed lines only |
| Redundancy | Coverage subset of another test plus no unique kills; same-setup groups for consolidation | Yes |
| Cost | Duration (mean of the measured runs), setup weight | Yes |
| Brittleness | Static: asserts on source text, CSS class names, doc wording, snapshot of whole files | Yes |
| Real catches | Failures confirmed as regressions (needs history and bisection) | No: this is what Vibernt Assay adds |
| Flakiness | Needs history | No: Vibernt Assay |

## Decision rules (spec owns the exact thresholds)

- **Keep**: any unique coverage, any unique kill, or critical tier.
- **Consolidate**: same target and setup with different data → one table-driven test; several files for one module → one file.
- **Rewrite**: brittle pins → behaviour assertions; slow and low-value → move down a layer.
- **Retire**: not critical, no unique coverage, no unique kill.
- Every removal passes `guard`. Critical tests are never removed by advice, only consolidated into another critical test.

## Mutation

- Operators: comparison flips, boolean negation, arithmetic swaps, return-value replacement, removed calls, boundary changes.
- Scope: changed lines (from a git diff) plus modules matched as critical. Never the whole codebase by default.
- Budget: a time and mutant cap per run; results report what was sampled.
- JavaScript parsing needs a real parser (decision D6: a small vetted parser such as acorn, or TypeScript's compiler API, versus no dependency and textual mutation). Python uses the standard library `ast` module.

## Config (`cupel.json` at the repository root, optional)

```json
{
  "spec": "cupel-spec/1",
  "runners": { "node": { "command": "node --test", "tests": "tests/**/*.test.mjs" } },
  "tiers": {
    "critical": ["src/auth/**", "src/billing/**", "migrations/**"],
    "minor": ["tests/docs-*.test.mjs"]
  },
  "mutation": { "critical": true, "changedLines": true, "maxMutants": 200, "maxSeconds": 300 },
  "guard": { "coverage": "ratchet", "criticalCoverage": 100 }
}
```

In-test tags override path rules: `[critical]` or `[minor]` in a test title (JS), `@pytest.mark.cupel_critical` (Python).

## Report format

JSON, validated by the spec's schema: `spec`, `generatedAt` (only when `--timestamp` is passed, so reports stay reproducible), `suite` totals, `tests[]` (id, file, name, tier, signals, advice, reasons), `groups[]` (redundancy and consolidation groups), `guard` result when present. The same object backs the CLI's human output, `--json`, the MCP tools and the Action summary.

## Integration seams (designed now, built later)

- `--assay <origin>`: opt-in upload of the report and download of history signals. Off by default; the only network call.
- An exit code and JSON contract stable enough for CodeCrystal's delivery checks.
- No Assay or CodeCrystal code inside Cupel.

## Repository layout (first build)

```
spec/                 the spec and conformance cases
packages/cupel/       the JS engine, collectors, CLI and MCP server (published as @vibernt/cupel, bin "cupel")
packages/cupel-py/    the pytest collector (published as vibernt-cupel), later the Python engine
action/               the GitHub Action
docs/                 user docs
plans/                these plans
```
