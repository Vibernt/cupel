# Cupel

**See which tests catch faults, then check that a test change keeps that protection.**

Cupel runs a project's tests, attributes source coverage to individual tests, and
introduces small source faults (mutants) to see which tests fail. It turns those
observations into a report and a bounded review pack. Its `guard` compares a Git
baseline with a proposed change and fails on lost coverage, lost critical
mutation protection, or a protected test removal without human approval.

**Open-source under MIT · version `0.1.0`.** Get the source from
[GitHub](https://github.com/Vibernt/cupel). npm and PyPI packages are not published;
use the local installation below. See the [verified candidate record](plans/results/2026-10-26-private-candidate.md)
for artifact checks and [historical evidence](docs/private-use.md#artifact-provenance).

Cupel supplies a Node CLI, a local stdio MCP server, and a pure JavaScript engine.
It makes no model calls and has no telemetry or analytics. The engine produces
the same report for the same inputs. Collection executes your project's tests
and configured preparation commands; their timings, side effects and network
behavior belong to that project. Cupel's own shipped runtime makes no network
calls and does not install project dependencies.

## Why add Cupel to your workflow?

A passing test suite can become less protective while staying green. An assertion
can get weaker, a refactor can stop checking a boundary, or an AI-generated test
can execute the right lines without detecting the wrong behavior. Coverage shows
which code ran; mutation testing checks whether tests notice particular faults.

Cupel gives you evidence to review those changes:

- **Understand existing tests.** See per-test coverage, mutation kills, timing,
  and gaps before deciding what to improve.
- **Protect test refactors.** Compare the proposed suite with a Git baseline
  and detect lost coverage or critical fault detection within the measured scope.
- **Review agent-written tests.** Give your coding agent a local CLI/MCP feedback
  loop, then inspect the evidence before accepting its changes.

Make protection review part of the workflow: **run tests → inspect Cupel evidence
→ edit → run full guard → review the diff**. Use it alongside your normal tests
and code review, especially when changing assertions or critical-path tests.

## How it works

1. **Collect:** run the supported test runner and attribute source coverage to
   individual tests.
2. **Challenge:** introduce small faults in the configured mutation scope and
   record which tests fail. A detected fault is called a killed mutant.
3. **Compare:** use `guard --base <ref>` to compare measured protection before
   and after a change. Lost coverage, lost critical kills and unapproved protected
   test removal can fail the guard even when the ordinary tests still pass.

The [launch post](docs/announcements/linkedin.md) explains the motivation and a
real-project example in a copy-ready format for LinkedIn.

## What is supported

The [support matrix](docs/support.md) is the authoritative version and scope contract.

| Scope | Runners | Evidence and limits |
| --- | --- | --- |
| Core ordinary full guard | `node:test`, Vitest, narrow Jest, pytest | Source and installed acceptance; exact runtime, loader and transform limits apply. |
| Bounded preview | Go, Ruby/Minitest, Rust/Cargo | Installed fixture acceptance; real-repository acceptance is unrun. |
| Experimental | Selective PR commands | Outside the supported first release; Node 26.7.0 profile only; Node 22 refuses. |
| Local integration | MCP; GitHub Action wrapper | MCP is tested locally. Hosted Action required checks and branch protection remain unverified. |

Real-repository Jest acceptance retained the original **51 tests / 4 files** and
killed all **11 valid unsampled critical mutants**. Weakening one assertion kept
the tests passing but made live CLI/MCP guard fail. See the
[pinned evidence](plans/results/2026-10-26-jest-acceptance.md).

A lack of unique coverage or kills does **not** prove a test is redundant.
Cupel never advises deleting a test. Review results do not establish cleanup
savings, and no generic CI speedup is claimed. `plan` orders tests; experimental
selective results cannot approve the whole suite.

## Run locally

You need Node **22+**, Git for baseline comparisons, and the assessed project's
dependencies already installed. Use the project's supported Vitest/Jest version;
pytest also needs Python **3.12+** and the separate Python collector. See
[installation](docs/install.md) for the Python wheel and exact tested versions.

Clone the repository, then run directly from source:

```sh
git clone https://github.com/Vibernt/cupel.git
cd cupel
CUPEL_REPO="$PWD"
node "$CUPEL_REPO/packages/cupel/bin/cupel.mjs" --help
```

Or pack and install this checkout into a local directory, entirely offline:

```sh
mkdir -p .scratch/local-package
npm pack --offline --ignore-scripts ./packages/cupel \
  --pack-destination .scratch/local-package
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix .scratch/local-install \
  .scratch/local-package/vibernt-cupel-0.1.0.tgz
CUPEL="$CUPEL_REPO/.scratch/local-install/node_modules/.bin/cupel"
"$CUPEL" --version
```

This installs a local tarball; there is no published registry installation.
No build step is needed for the JavaScript package. The
[artifact smoke tests](docs/development.md#installed-artifact-gates) check the
actual tarball, wheel, CLI and MCP entry points.

## Review a test change

Set `CUPEL` with the installation above, then enter the Git root of the project
you want to assess (replace the example path):

```sh
cd /absolute/path/to/your/project
"$CUPEL" report --runs 2
"$CUPEL" review --input .cupel/input.json --limit 10 --json
```

`report` collects the suite, runs configured mutation, and saves its input to
`.cupel/input.json`. `review --input` reads that saved evidence. Read the named
tests and their assertions before changing them. Configure `cupel.json` to mark
critical paths and select runners when needed; see the
[config guide](docs/extending/config.md) and [CLI reference](docs/cli.md).

After an uncommitted test change, compare against the commit containing the
original tests:

```sh
"$CUPEL" guard --base HEAD --runs 2
```

For an already committed change, use its actual earlier baseline ref. The
baseline runs in a fresh Git archive; prepare its project dependencies and build
steps as described in [baseline collection](docs/cli.md#baseline-dependencies).
Keep mutation enabled for a protection check. Unsupported collection or mutation
stops with a reason; Cupel does not silently switch to coverage-only collection.
Exit codes are `0` OK, `1` a guardrail/check failed, `2` invalid usage/input, and
`3` an environment failure. A passing guard covers its measured scope and rules.

| Command | Purpose |
| --- | --- |
| `report`, `review` | Inspect measured coverage, mutation, timings and review hints. |
| `check <tests>` | Inspect evidence added or lost by named tests. |
| `guard --base <ref>` | Compare protection with an earlier commit. |
| `label`, `plan` | Inspect tiers and test execution order. |
| `import`, `validate` | Read JUnit/Cupel data and validate spec documents. |

## Use with an agent

Start the installed MCP server over stdio with an explicit target root:

```sh
"$CUPEL" mcp --root /absolute/path/to/your/project
```

Configure your MCP client to start that executable with the same arguments.
[MCP setup](docs/mcp.md) covers Claude Code, Cursor and Codex, available tools,
pagination and retained report snapshots. Agents can inspect evidence through
`cupel_review` and run a fresh `cupel_guard`; Cupel does not create human approvals.

## Develop and extend

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for checks, repository rules and
[development tooling](docs/development.md). The [docs index](docs/README.md)
groups usage, runners, extension contracts and acceptance evidence.

| Path | Contains |
| --- | --- |
| `packages/cupel/` | JavaScript engine, collectors, mutation backends, CLI and MCP. |
| `packages/cupel-py/`, `packages/cupel-ruby/` | Python and Ruby collector runtimes. |
| `spec/` | `cupel-spec/1`, schemas and positive/negative conformance cases. |
| `action/`, `scripts/`, `bench/` | Action wrapper, local verification and audited benchmarks. |
| `docs/`, `plans/` | User/developer docs; decisions, plans and historical evidence. |

## Licence

First-party Cupel code is licensed under [MIT](LICENSE). See [NOTICE](NOTICE)
for attribution and third-party material. The source repository is public;
package registry publication is managed separately.
