# CLI reference

```
cupel <command> [options]
```

Cupel never uses the network and never modifies your working tree. Every command that scores tests runs the same pure engine, so `--json` prints exactly the engine's report (`spec/schemas/report.schema.json`).

## Commands

| Command | Does |
|---|---|
| `cupel report [--input <file>] [--no-mutation] [--runs N] [--out <file>]` | Scores every test and gives advice. Without `--input` it collects the suite, runs mutation per config, re-checks and targets retire candidates (below), and writes the final input to `.cupel/input.json` (or `--out`) |
| `cupel check <test ids or files…> [--base <ref> \| --base-input <file>] [--input <file>]` | Does a new or changed test add anything? A file argument expands to the units of the tests in that file. With a base, also reports tests that got weaker |
| `cupel guard --base <ref> [--approvals <file>]` | Fails if coverage or critical mutation fell between the base and the working tree. `--base-input <file>` and `--head-input <file>` replace either side with a saved input |
| `cupel plan [--changed <ref> \| --changed-lines <file>] [--input <file>]` | Priority order for a run: critical first, then tests affected by the change, then the rest |
| `cupel label [--input <file>]` | Shows each unit's tier and why. Exits 1 on an unknown tag |
| `cupel import <file…> [--format cupel\|junit] [--out <file>]` | Writes a valid input to standard output or `--out` |
| `cupel validate <file>` | Checks an input, report or config against the spec schemas |
| `cupel conformance --adapter "<command>" [--fixtures <dir>]` | Runs an adapter in each fixture of `spec/conformance/adapters/` and matches its output against `expected.json` |

`cupel mcp [--root <dir>]` starts the [local MCP server](mcp.md) over stdio.

## Options

Common to every command:

| Option | Meaning |
|---|---|
| `--config <file>` | The config. Default: `cupel.json` at the git root, or none (the defaults) when it is absent |
| `--json` | Print the engine report unchanged, as JSON |
| `--quiet`, `-q` | No progress messages on standard error |
| `--help`, `-h` | Help for the command |

Per command:

| Option | Commands | Meaning |
|---|---|---|
| `--input <file>` | report, check, plan, label | Read the input instead of collecting. `report --input` replays a saved input as is: no collection, no mutation, no second pass |
| `--out <file>` | report, check, plan, label, import | Where to write the collected (or imported) input. `report` writes `.cupel/input.json` by default; the others write it only when asked |
| `--runs N` | report, check, guard, plan, label | Collection repeats, for durations. Default 2 |
| `--no-mutation` | report, check, guard | Skip mutation and the retire-evidence pass |
| `--base <ref>` | check, guard | Collect the base from a git ref |
| `--base-input <file>`, `--head-input <file>` | check, guard | Saved inputs for either side (`check` also takes the head as `--input`) |
| `--approvals <file>` | guard | A JSON list of `{ "action": "remove" \| "downgrade", "id", "by" }`, or an object with that list as `approvals` |
| `--changed <ref>` | plan | Changed lines from `git diff --unified=0 <ref>` |
| `--changed-lines <file>` | plan | Changed lines as JSON: `{ "path": "line set" }`, `""` for a whole file |
| `--generated-at <text>` | report, check, guard, plan, label | Copied into the report as `generatedAt`. Cupel never reads the clock for a report |
| `--format cupel\|junit` | import | Default `cupel` |
| `--runtime-name <n>`, `--runtime-version <v>` | import | The runtime recorded by a JUnit import (default `unknown`) |
| `--adapter "<command>"`, `--fixtures <dir>` | conformance | The adapter command (run through the shell), and the fixtures directory |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | A guardrail or check failed (`check`, `guard`, `label` on unknown tags, `validate` on an invalid file, `conformance` on a mismatch) |
| 2 | Usage error or invalid input |
| 3 | Environment: a runtime mismatch, a collector or git failure, `collector not available`, a failed `prepare`. The reason is one line on standard error |

## How the commands collect

- **Collection** uses the node:test collector. When it is not installed, any command that must collect exits 3 with `collector not available`; everything that takes `--input`, `--base-input` or `--head-input` still works.
- **Mutation** follows config `mutation`: critical sources, and for `check` and `guard` with `--base`, changed lines. When the mutation module is missing, Cupel says so and continues without mutation data (missing data is never "no kill").
- **`--base <ref>`** runs `git archive <ref>` and unpacks it into a fresh directory under the system temp directory, runs `runners.node.prepare` there, collects, and removes the directory. It never checks out, stashes or writes anything in your repository. Mutants detected at base that survive at head are re-run (K7).
- **Retire evidence.** `report` runs the engine once, takes the units that end with hint `no-unique-coverage-unverified` and no `retire-conflict` (at most `mutation.maxMutants` of them, by id), re-checks each in its own process, runs targeted mutation on their own lines, and runs the engine again. This needs both the collector and the mutation module, and is skipped with `--no-mutation`.
- **Changed lines** (`--changed`): added or modified lines count by their line numbers in the new file. A hunk that only deletes lines marks the line before it. New, untracked (not ignored) and binary files count as changed in full. Deleted files are left out. Renames count as a new file.

## Importing JUnit XML

`cupel import --format junit results.xml [more.xml…]` turns JUnit XML into an input with tests, statuses and `durationsMs`, empty `sources`, and `file` granularity coverage with no `byFile`. The engine can then plan, label and report, but never advises retiring a test from results alone.

- **Ids** are `<file or classname>::<name>`. The first part is the testcase's `file` attribute, else its `classname`, else the nearest enclosing testsuite's `file`, else its `name`.
- **Status**: a `<failure>` or `<error>` child means failed, `<skipped>` means skipped, anything else passed (including surefire's `<flakyFailure>`).
- **Several files** (or the same id twice) are several runs of a test: durations are appended, a test failed if any run failed, and is skipped only if every run was skipped.
- **Durations**: `time` in seconds, rounded to milliseconds. A `time` with only a decimal comma (`0,5`) is ambiguous and recorded as no duration.
- **Tags**: `[critical]`, `[standard]` or `[minor]` in a test name becomes a tier tag.
- Nested testsuites are supported. DOCTYPE entity declarations are refused.

## Validate

`cupel validate <file>` picks the schema from the `kind` field: `input`, `report`, or a config when there is no `kind`. Inputs also get the engine's integrity checks (unknown tests, lines that are not coverable, and so on), and configs the tier-word check. Each error is printed with its JSON pointer. `--json` prints `{ file, kind, valid, errors: [{ path, code?, message }] }`. Exit 0 when valid, 1 when not, 2 when the file cannot be read.

## Conformance

`cupel conformance --adapter "<command>"` runs the command in each fixture directory, parses its standard output as an input, checks it against the input schema, and matches it against the fixture's `expected.json` (spec section 16). It prints `pass` or `FAIL` per fixture with every mismatch. The fixtures are read from the repository's `spec/conformance/adapters/`; outside the repository, pass `--fixtures <dir>`.

## Output

Human output is short:
- `report`: a summary line (tests, units, coverage, mutation score), the units whose advice is not `keep` grouped by advice, then a count of each hint.
- `guard`: each check with `pass` or `FAIL`, the removed units, and the verdict.
- `check`: one line per verdict.
- `plan`: the order with buckets and durations; `label`: each unit's tier and reason.

Diagnostics follow, one per line. Colour is used only when standard output is a terminal and `NO_COLOR` is not set.

## Testing hooks

With `NODE_ENV=test` only, `CUPEL_TEST_COLLECTOR` and `CUPEL_TEST_MUTATOR` name module paths that replace the collector (`collectNode`) and the mutation module (`mutateNode`, `confirmSurvivors`). A path that does not exist counts as not available. Both variables are ignored otherwise.
