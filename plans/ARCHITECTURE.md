# Architecture

## Parts

| Part | What it is |
|---|---|
| **Spec** (`spec/`) | The single source of truth: tier labels and path rules, the value signals and how they combine, the keep/consolidate/rewrite/retire rules, guardrails, the **input format** (what collectors and importers hand the engine), the report format and the config format, each as a JSON Schema. Versioned (`cupel-spec/1`) |
| **Conformance cases** (`spec/conformance/`) | Input fixtures (results, coverage, mutation outcomes, config) with the exact expected report. Every implementation must pass all of them |
| **Engine** | Pure, deterministic functions: inputs in, report out. No I/O beyond what is passed in, no clock, no randomness without a seed, no runtime APIs (`node:*`, `process`). So the same engine runs in the CLI, the MCP server and, later, server-side in Vibernt Assay (Cloudflare Workers): local scores and Assay scores always match |
| **Collectors** | Run the user's tests and produce the engine's inputs: per-test results, per-test coverage, changed-line mutation outcomes. One per runner: node:test, Vitest, Jest, pytest first |
| **Importers** | Convert what existing tools already produce (JUnit XML, coverage.py contexts, JaCoCo, PIT, Stryker, cargo-mutants and others) into the input format, so Cupel scores suites it has no native collector for |
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
| `cupel import <files> [--format <f>]` | Reads engine inputs from files instead of running a collector: Cupel's own input format, or a supported tool format | Validated inputs, then the same `report`, `check`, `guard` and `plan` as a native run |
| `cupel mcp` | Starts the MCP server | stdio |

Exit codes are stable and documented: 0 ok, 1 guardrail or check failed, 2 usage error, 3 environment error (a collector could not run).

## MCP tools (local, stdio)

`cupel_check`, `cupel_report` (whole suite or a file), `cupel_guard`, `cupel_plan`, `cupel_label`. Each returns compact JSON plus a one-line summary; long reports are paged. The tool descriptions tell the agent when to call them (before committing new tests: `cupel_check`; before removing tests: `cupel_guard`).

## Languages and runners

The engine is language-neutral: it sees only test ids, the lines each test covers, results, durations and which mutants each test killed. Everything language-specific lives in a collector, an importer or a mutator, and all of them produce the same input format. Anyone can add a runner or a language by emitting that format, without touching the engine.

| Language | Per-test coverage | Mutation | Milestone |
|---|---|---|---|
| JavaScript, TypeScript | node:test (S2 hook), Vitest, Jest | Cupel's own textual mutator (D6); import Stryker | M3, M6 |
| Python | pytest with a standard-library `sys.monitoring` plugin; import coverage.py contexts | Cupel's own mutator on `ast`; import mutmut | M6 |
| Java, Kotlin | JaCoCo with per-test sessions (JUnit 5 listener) | Import PIT | M6b |
| Go | `go test -run` per test with `-coverprofile`, or `go test -json` with per-test profiles | Import an existing Go mutator, or Cupel's own | M6b |
| .NET | coverlet, per test | Import Stryker.NET | M6b |
| Rust | `cargo llvm-cov` per test | Import cargo-mutants | M6b |
| Ruby | standard-library `Coverage` with RSpec or Minitest hooks | Import mutant | M6b |
| PHP | php-code-coverage (PCOV or Xdebug) with PHPUnit's per-test "covered by" data; Pest runs on PHPUnit | Import Infection | M6b |

Results and durations come from JUnit XML wherever a runner emits it.

### Frameworks: per language, plus a thin adapter

Most of the work is per language, not per framework:

| Layer | Varies by | Notes |
|---|---|---|
| Coverage engine | Language | V8 for every JS framework, `sys.monitoring` for Python, JaCoCo for the JVM, and so on |
| Mutation | Language | Mutates the source, then re-runs the selected tests through the framework's own filter |
| Results and durations | Almost nothing | JUnit XML |
| Per-file coverage | Nothing | Coverage per process, tagged with its test file (S1). Works for any framework with no framework code |
| Per-test coverage | Framework | Needs the boundaries between tests |

Every framework gets per-file coverage with no adapter. Per-test coverage needs a **framework adapter** (about 100–200 lines) that implements a contract the spec defines:
1. **List:** enumerate tests with stable ids (file plus full name).
2. **Select:** run a given subset of tests (the framework's name or id filter).
3. **Boundaries:** mark where each test starts and ends, including hooks and setup, for per-test coverage.
4. **Tags:** read in-test tier tags in the framework's idiom (a title tag, a marker, an annotation or a group).

First-party adapters:

| Language | Frameworks |
|---|---|
| JavaScript, TypeScript | node:test, Vitest, Jest, Mocha |
| Python | pytest, unittest |
| Java, Kotlin | JUnit 5, Kotest |
| Go | `go test` (the only one) |
| .NET | xUnit, NUnit, MSTest (one VSTest data collector covers all three) |
| Rust | `cargo test`, cargo-nextest |
| Ruby | RSpec, Minitest |
| PHP | PHPUnit, Pest |

Any other framework can be added by the community through the public input format (D10).

**Where advice is weaker.** End-to-end and browser tests (for example Playwright), and any test that drives several services or processes, cannot have their coverage attributed reliably to one test. Cupel still labels, guards and orders them, but it marks their keep and retire advice "low evidence" and never advises retiring them on coverage alone. Flakiness and real catches need run history (Vibernt Assay).

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
