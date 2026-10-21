# M3 design: how the Node build fits together

The engine (`src/engine/`) is done and passes every conformance case. M3 adds three parts around it. Each has a fixed interface so they can be built in parallel. The rules in [AGENTS.md](../../AGENTS.md) apply to all of them.

```
cupel (CLI)  ──►  collect/node  ──►  input (cupel-spec/1)  ──►  engine.run  ──►  report
     │                 ▲                     ▲
     └──► mutate ──────┴─────────────────────┘  (adds input.mutation)
```

## Layout

| Path | Owner | What |
|---|---|---|
| `src/engine/` | done | Pure engine. Do not change it without a conformance case |
| `src/lang/js/lexer.mjs` | done | Shared JavaScript lexer (D6) |
| `src/collect/node/` | collector | The node:test collector |
| `src/mutate/` | mutation | Mutant generation, the load hook and the runner |
| `src/cli/` and `bin/cupel.mjs` | CLI | Commands, config loading, git, output |
| `src/conformance/match.mjs` | done | Conformance matching |

Only `src/engine/` must be pure. Every other part may use Node APIs, but never the network: `scripts/check.mjs` enforces that for all of `src/`. No module uses a clock or randomness in a way that changes a report: durations are inputs, and sampling uses `config.mutation.seed`.

## Interfaces

### Collector: `src/collect/node/index.mjs`

```js
collectNode({ root, config, files, runs = 2, recheck = [], log }) -> Promise<input>
```

- `root`: the absolute repository root. `config`: the effective config, with defaults applied. `files`: test files to run (default: `config.runners.node.tests`, or `tests/**/*.test.mjs`).
- **Running.** Runs the suite with one ordinary `node --test` per repeat, with the per-test coverage preload from spike S2 (method B). `runs` repeats give `durationsMs`; coverage comes from the first repeat. If `runners.node.prepare` is set, run it once before the tests.
- **Output.** Returns a complete `cupel-spec/1` input:
  - `runtime`
  - `sources` with `coverable` (K1) and `hash` (sha256 of the file), over the whole repository minus test directories, `node_modules` and dot-directories, narrowed by `config.scope` (K2)
  - `tests` with ids, units and tags (K10, title tags such as `[critical]`), status, `durationsMs`, and `spawnsInterpreter` (K11)
  - `coverage` with `byTest`, `setup` and `rechecked` (K3, K4)
  - `brittleness` from the strict detector of spike S6, plus `config.brittleness.patterns`
  - `shapes` (K12)
- **Re-check (K4).** `recheck` lists unit ids. Each is run in its own process with `--test-name-pattern`, its coverage replaces the shared-process coverage, and it is listed in `coverage.rechecked`.
- **Fixture.** It must reproduce `spec/conformance/adapters/node-test/expected.json`.

### Mutation: `src/mutate/index.mjs`

```js
mutateNode({ root, config, input, scope, log }) -> Promise<mutation>
```

- `scope`: `{ critical: bool, changed: { path: lineSet } | null, targeted: [unitIds] }`.
  - **critical:** every coverable line of a critical source, per spec section 5.
  - **changed:** the changed lines.
  - **targeted:** the own lines of those units (D5).
- **Generating.** Mutants come from the S3 operators over the shared lexer, filtered for validity with `vm.SourceTextModule`, falling back to `node --check`. They are capped at `config.mutation.maxMutants` and sampled deterministically with `config.mutation.seed`. Mutant ids are stable for the same source text and site.
- **Running.**
  - Mutants are served in memory through a module load hook, never written to disk (K6).
  - Tests are selected by coverage from `input.coverage`.
  - A kill counts only when a test reports a failure (K5), and every killing test id goes in `killedBy`.
  - A timeout is 3× the selected tests' baseline time.
  - Stop after `config.mutation.maxSeconds`, and report `sampled: true` when anything was cut.
- **Output.** Returns `input.mutation`: `mutants`, `targeted` (units whose own-line mutants were all run), `seed` and `sampled`.
- **Flakes (K7).** `confirmSurvivors({ root, input, mutation, ids })` re-runs the given mutants twice more, and keeps `survived` only if they survive every time.

### CLI: `bin/cupel.mjs` and `src/cli/`

Commands:

| Command | Does |
|---|---|
| `cupel report [--json] [--input <file>] [--no-mutation] [--runs N]` | Collects (or reads `--input`), runs mutation per config, re-checks and targets retire candidates (below), then runs the engine |
| `cupel check <test ids or files…> [--base <ref>]` | |
| `cupel guard --base <ref>` or `cupel guard --base-input <f> --head-input <f>` `[--approvals <file>]` | With `--base`, the base is collected from `git archive <ref>` unpacked into a temporary directory, never a checkout of the user's working tree |
| `cupel plan [--changed <ref>]` | Changed lines come from `git diff --unified=0 <ref>` |
| `cupel label` | |
| `cupel import <file> [--format cupel\|junit]` | Writes a valid input to standard output or `--out` |
| `cupel validate <file>` | Checks an input, report or config against the spec schemas |
| `cupel conformance --adapter <command>` | Runs the command in each fixture directory and matches its output against `expected.json` |

Common options: `--config <file>` (default `cupel.json` at the git root), `--json`, `--out <file>`, `--quiet`.

**Retire evidence (D5).** `report` runs the engine once. It takes every unit that ends with hint `no-unique-coverage-unverified` and no `retire-conflict` (at most `config.mutation.maxMutants` worth), re-checks those units, runs targeted mutation on them, merges the results into the input, and runs the engine again. The final input is written to `.cupel/input.json`, so `--input` can replay it.

**Output and exit codes.**
- Human output is short: a summary line, then the units that have advice other than `keep`, then the hints.
- `--json` prints the engine report unchanged.
- Exit codes are the engine's: 0, 1 or 2. A collector or git failure exits 3 with a one-line reason.

**Config additions** (additive, `cupel-spec/1`): `runners.<name>.prepare` (a command run once before collecting) and `runners.<name>.env` (extra environment variables).
