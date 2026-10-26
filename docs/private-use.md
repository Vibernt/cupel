# Use the private candidate

The [support matrix](support.md) defines JS/TS/Python core ordinary full guard
and bounded Go/Ruby/Rust preview. Private experimental selective PR commands
remain outside the supported first release; their scoped results always have
`wholeGuardPass: false`, and Node 22 selective execution refuses. Full `guard`
is the whole-suite protection path. No generic CI speedup is claimed.

## Choose an executable

Build/install the current **0.1.0 candidate** using [the local installation
guide](install.md). Its examples set an absolute `CUPEL` executable in
`.scratch/local-install`. To use the maintainer's retained accepted installation:

```sh
CUPEL=/Users/vid/cupel/.scratch/cupel-install/node_modules/.bin/cupel
"$CUPEL" --version
```

Check the version and corresponding handoff before relying on that stable path.
It may contain an older artifact. Node 22+ and your project's dependencies must
be on `PATH` or resolvable from the project; Cupel installs no runner.
Jest support is exactly Jest, jest-circus and jest-environment-node **30.2.0**,
one project, Node environment, within [Jest limits](jest.md).

## Review and protect a change

From the Git root of the project being assessed, with `CUPEL` set:

```sh
"$CUPEL" report --runs 2
"$CUPEL" review --input .cupel/input.json --limit 10 --json
```

Read the named tests and their assertions. A `no-unique-evidence` hint is not
proof that a test can be removed. After editing, compare with the commit that
still contains the original protection. For an uncommitted change:

```sh
"$CUPEL" guard --base HEAD --runs 2
```

For an already committed change, supply its actual earlier baseline ref. The
Git archive used for the baseline needs its own prepared dependencies/build;
see [baseline dependencies](cli.md#baseline-dependencies). Keep mutation enabled.
Missing mutation support exits 3; Cupel does not silently select `--no-mutation`.
Exit 1 means a guardrail failed, 2 means invalid usage/input, and 3 means an
environment failure. A person's explicit approval is required for a protected
removal or downgrade. A guard only establishes its measured scope and rules.

Mutation checks source bytes and paths before and after execution. Source changes,
opaque hashes, unsafe/hardlinked paths or missing required `O_NOFOLLOW` filesystem
capability refuse with exit 3. Current artifact acceptance covers macOS on Node
22.23.3 and 26.7.0; other operating systems remain unverified.

## Local MCP and Python

Start the same executable over stdio with the target root:

```sh
"$CUPEL" mcp --root /absolute/path/to/project
```

The [MCP guide](mcp.md) lists client configuration and tools. For report paging,
`cupel_report` with `retain: true` returns a `snapshotId`; subsequent pages from
that snapshot are historical report views, with no collection or mutation.
Use a fresh guard for protection checks.

For pytest, use Python 3.12+ with pytest and the installed collector, putting
that environment's `bin` first on `PATH`. The verified interpreter for a handoff
is recorded in its `handoff.json`; do not assume an old temporary environment
still exists. See [installation](install.md) and [Python limits](python.md).

## Artifact provenance

The current source candidate is **0.1.0**. Its verified handoff is
`.scratch/private-candidate/release-0.1.0/handoff.json`; the stable executable
above now contains that version, with the prior installation retained for rollback.
See [the candidate record](../plans/results/2026-10-26-private-candidate.md) for
archive hashes and fresh checks.

The current source candidate is **0.1.0**. A source version and the tests of an
older artifact do not certify a newly packed archive. Use its actual handoff and
SHA-256 to identify an accepted installation.

The earlier `.scratch/private-candidate/handoff-scope-ALquxx/handoff.json`
describes a **historical private 0.0.0 artifact**. Its Jest-accepted tarball hash
is `c17c2e3814015e277c882addeeb0e1416004fe78051b87360f6500594435c15f`.
It passed **615 Node outcomes on each of Node 26 and Node 22**, **45 Python tests,
no skips**, and **35 Ruby tests / 148 assertions**. Its predecessor is retained
in that handoff's `previous-install/`; the preceding grid handoff is
`.scratch/private-candidate/handoff-grid-IGHL17/handoff.json`.
These records remain historical after the source version/licence changes.
Current candidate gates belong in the [release checklist](../plans/FIRST-RELEASE-CHECKLIST.md).

The [real-repository ordinary Jest acceptance](../plans/results/2026-10-26-jest-acceptance.md)
passed on the complete original **51 tests / 4 files**, with **11 valid unsampled
critical mutants killed**, a weakened-assertion negative control and exact live
CLI/MCP parity. Native preview fixture acceptance does not establish native
real-repository acceptance. Hosted Action checks/branch protection remain
unverified. [Selective PR evidence](selective-pr.md) belongs to the separate
private experiment and does not expand first-release support.
