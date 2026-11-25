# Faster fault testing

Fault testing (mutation testing) is the slow part of Cupel. It plants one small
fault, runs the tests, records whether they noticed, undoes it, and repeats. Every
tool of this kind works that way. This page explains what Cupel does on its own to
keep it fast, the settings you control, and recipes for local runs, pull requests,
nightly runs and CI machines that start empty.

None of these trade reliability for speed. A fault counts as caught only when a
test fails on it; whatever Cupel skips is skipped because its answer is already
known.

## What Cupel does on its own

| Step | What it means | Runners |
| --- | --- | --- |
| **Only the tests that run the line** | A fault on line 40 is tested only with the tests whose coverage includes line 40. Other tests cannot notice it. | node:test, Vitest, Jest, pytest. Go and Rust: by package (below) |
| **Most relevant, fastest tests first** | Test files that run the line most come first, then the quickest. Go package order additionally starts with prior catchers and the matching same-directory `_test.go` package. | node:test, Vitest, Jest, Go |
| **Stop once the answer is known** | A fault stops running after two different tests (two test files in JavaScript, two units in Python, two packages in Go) have caught it. Two, not one, so Cupel still knows whether a test is the only one that catches it. A unit that a review is asking about always gets every test run. | node:test, Vitest, Jest, pytest, Go |
| **Time limits from measured times** | Each test file (or pytest/Go package selection) is first run once unmutated. A fault run may take three times that, with a floor of one second; a run that times out is retried once with a longer limit before it counts as a timeout. | node:test, Vitest, Jest, pytest, Go; cargo-mutants sets its own limits from its baseline |
| **Skip what no test runs** | A fault on a line no passing test runs is reported as `no-coverage` without being run. For Go and Rust this saves a build and test run per fault. | node:test, Vitest, Jest, pytest, Go, Rust |
| **Only the Go packages whose tests run the code** | Go compiles the faulty source package first, then only packages holding covering tests. `-run` selects exactly the recorded top-level tests; setup/file coverage expands to every test in that package. | Go |
| **Only the Rust packages whose tests run the code** | When the tests that run the faulty lines all live in some workspace packages, only those packages' tests run, plus the package that owns the faulty file (`--test-package`). A test elsewhere does not run the line. If Cargo features change when one package is built alone, set `wholeWorkspace`. | Rust (cargo-mutants) |
| **Reuse earlier answers** | A fault whose code, covering tests and everything those tests read are unchanged since the last run copies its earlier result. See [Reuse](#reuse-earlier-results). | node:test, Vitest, Jest, pytest, Go, Rust (both backends). Ruby records fingerprints but runs every fault |

## Settings

In `cupel.json` (full list in the [config schema](../spec/schemas/config.schema.json)):

```json
{
  "mutation": {
    "critical": true,
    "changedLines": true,
    "maxMutants": 200,
    "maxSeconds": 300,
    "seed": 20261021,
    "reuse": { "ignore": ["docs/**", "**/*.md"] }
  },
  "runners": { "cargo": { "mutants": { "jobs": 2 } } }
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `mutation.critical` | `true` | Test faults in every file marked critical, in full, on every run. Set `false` on pull requests to test only changed lines. |
| `mutation.changedLines` | `true` | With `guard --base`, `guard --base-input … --changed <ref>`, `check --base` or `mutate --changed`, test faults on the lines the change touched. |
| `mutation.maxMutants` | 200 | At most this many faults per run. Beyond it, Cupel takes a seeded sample (the same sample every time for the same code) and reports `sampled: true`. Faults on lines a reviewed unit owns come first. Applies to Rust too. |
| `mutation.maxSeconds` | 300 | Stop starting new faults after this many seconds (not for Rust: cargo-mutants has no overall budget). |
| `mutation.seed` | fixed | Changes which sample is taken. Keep it fixed so runs stay comparable. |
| `mutation.reuse` | on | `false` switches reuse off. `ignore` lists files whose changes can never change a test result, such as docs no test reads. `env` adds environment variables whose values change test results. |
| `runners.cargo.mutants.wholeWorkspace` | false | Test every workspace package for every Rust fault. Use it when Cargo features differ between one package alone and the whole workspace. |
| `guard.firstCatch` | true | `guard` collects the head's faults stopping at the first catching test (see below). `false` records catches fully. |
| `runners.cargo.mutants.jobs` | 1 | Rust faults built and tested in parallel. Each job needs its own build and memory. |

## Pull requests: stop at the first catch

A pull request's guard needs one answer per fault: was it caught? It never needs
*which* tests caught it, or whether only one test does. So `guard` collects the
head with each fault stopping at its **first** catching test file (JavaScript),
test (Python), test package (Go) or test target (Rust), instead of the second. Statuses are exactly
the same; the list of catching tests is shorter.

This matters most where one test is the only one catching a fault: proving it is
the only one means running every other test that runs the line, slow ones
included. On a private Rust workspace that was 60% of all fault-testing time.

The result is marked `mutation.catches: "first"`. Because unique catches and
overlaps cannot be computed from it, every command refuses it (rule I6) except
`guard`, for its head; reuse and `merge-mutations` never mix it with full results.
The base side of `guard` always records catches fully, since a removed test is
described by what only it caught. Turn the mode off with
`"guard": { "firstCatch": false }`; use `cupel mutate --first-catch` to produce
such a head for `guard --head-input` in CI. `report`, `audit`, `review` and
`check` always record catches fully. The cargo-mutants backend runs every test
anyway; the gain is for JavaScript, Python and `backend: "cupel"`.

## Reuse earlier results

Every fault result Cupel writes carries a `basis`: a fingerprint of everything
that could change it:

- the fault itself and the tests that run its line, with their files;
- every other project file those tests could read: helpers, fixtures, configs,
  lock files, and git-ignored files such as `.env` or build output (dependency,
  build and cache folders like `node_modules/` and `target/` aside);
- what is installed: npm, pnpm and Yarn records in `node_modules`, and the
  packages in a Python virtual environment;
- for a project inside a larger repository, the files in each folder above it;
- Cupel's version, the OS, the runtimes, the runner config, and environment
  variables that change how tests run (`NODE_OPTIONS`, `NODE_ENV`,
  `PYTHONOPTIMIZE`, `PYTEST_ADDOPTS`, `RUSTFLAGS`, `CI` and others; add your own
  with `reuse.env`).

Sources and test files that those tests never run are left out, so editing an
unrelated module does not throw away results. Two cases count every source
instead, because coverage cannot see what they depend on: compiled languages
such as Rust and Go (their compilers copy constants, macros and generics across
files), and test files with a test that starts another program or interpreter or
is end-to-end.

On the next run, a fault whose fingerprint is the same is copied instead of run,
and marked `reused`. These always run again:
- timeouts and errors;
- faults caught by a test outside the fault's own run, such as cross-runner catches;
- faults a unit under review covers, since that unit needs every test run.

`guard` re-runs survivors that the base caught (K7). A copied fault still counts
toward `maxMutants`, so the sample is the one a fresh run would take.

Where the earlier results come from:

- **`report`, `review`, `audit`:** `.cupel/input.json` from the last run is used
  automatically.
- **`guard`, `check`, `mutate`:** only a file named with `--reuse <file>`. These
  commands judge a change, and a file inside the change could be planted, so they
  never read the in-tree default.
- **A missing `--reuse` file** is not an error: every fault runs. Use this in CI.
- **Never:** `--no-reuse`, or `"mutation": { "reuse": false }`.

**Trust.** A fingerprint is a checksum, not a signature: anyone can compute one.
Reuse only results your own runs produced, such as a CI cache written by runs on
your main branch. Never pass `--reuse` a file that comes from the change under
review.

Cupel's own files never count as project files: `.cupel/`, `.scratch/`, and the
files named by `--reuse` and `--out`. Keeping the earlier input in `.cupel/`, as
the recipes below do, is simplest.

**When to add `reuse.ignore`.** Reuse is conservative: any change to any project
file the tests could read invalidates the results that depend on it, and Cupel
cannot tell which files a test reads at run time. If no test reads your docs, add
them to `ignore` so a README edit does not re-run everything. Never ignore
fixtures, snapshots or data files that tests open.

## Recipes

### Local, while editing

```sh
cupel report            # first time: everything; later: only what changed
cupel audit --input .cupel/input.json
```

### Pull requests

Test only the changed lines, compare with the base, and reuse main's results:

```json
{ "mutation": { "critical": false, "changedLines": true, "maxMutants": 100 } }
```

```sh
cupel guard --base origin/main --reuse .cupel/main.json --out .cupel/head.json
```

When CI already keeps main's collected input, skip collecting the base again:

```sh
cupel guard --base-input .cupel/main.json --changed origin/main \
  --reuse .cupel/main.json --out .cupel/head.json
```

Keep critical files in full (`"critical": true`) on pull requests only when that
fits your time budget; otherwise run them nightly.

### Nightly or on main

Full critical fault testing, reusing yesterday's results, saving today's for the
next run and for pull requests:

```sh
cupel report --reuse .cupel/main.json --out .cupel/main.json
```

### CI machines that start empty

A fresh CI machine has no `.cupel/input.json`. Keep the input file between runs
with your CI's cache or artifacts and pass it back with `--reuse`. A GitHub
Actions sketch:

```yaml
- uses: actions/cache/restore@v4
  with:
    path: .cupel/main.json
    key: cupel-main-${{ github.sha }}
    restore-keys: cupel-main-
- run: cupel guard --base-input .cupel/main.json --changed origin/main --reuse .cupel/main.json --out .cupel/head.json
  if: github.event_name == 'pull_request'
- run: cupel report --reuse .cupel/main.json --out .cupel/main.json
  if: github.ref == 'refs/heads/main'
- uses: actions/cache/save@v4
  if: github.ref == 'refs/heads/main'
  with:
    path: .cupel/main.json
    key: cupel-main-${{ github.sha }}
```

The cache only saves time. A result is reused only when its fingerprint matches
today's files, so an old cache entry cannot make a fault look caught. Write the
cache only from runs on your main branch, and never restore a file that a pull
request could have written.

### Rust

- Cache Cargo's `target/` directory and registry in CI (for example
  `Swatinem/rust-cache`). Each fault rebuilds the changed crate, and a warm cache
  avoids rebuilding everything else.
- Mark only the files that matter as critical; Rust faults cost a build each.
- Use `jobs` above 1 only with memory to spare: each job holds its own build.
- See [Rust](rust.md) for what cargo-mutants runs and what Cupel refuses.

### Worker code in workerd

Fault testing runs in a scratch copy of the project, one fault at a time, and
each fault restarts workerd. Keep critical Worker files small and focused, and
prefer `changedLines` on pull requests. See [workerd](workerd.md).

## Rust: Cupel's own fault runner

With `"runners": { "cargo": { "mutants": { "backend": "cupel" } } }`, Cupel takes
cargo-mutants' list of faults (so fault ids and the way catches are credited match the default backend; doctests are not run, so a fault only a doctest catches is reported unnoticed)
and tests them itself:

1. **Only the test targets that run the line.** Each test file is its own build
   target; only the targets holding a test that runs the faulty line are built,
   and inside them only those tests run (by exact name).
2. **Fastest first, stop after two.** Those targets run with the most relevant and
   quickest first, and a fault stops once two targets caught it, the same rule as
   JavaScript and Python. A unit under review gets every target run.
3. **One build for many faults.** Faults the rewriter is certain about are compiled
   into one build, each switched on by a number in the `CUPEL_FAULT` environment
   variable. With every switch off, each test target must behave exactly as
   unmodified, or that target is not run on the switched build: timing-budget
   tests usually differ, and run only for faults the other targets did not settle,
   on a build of that fault alone. Any fault the rewriter is unsure of
   (inside macros, `const` code, or expressions it cannot bound exactly) gets its
   own incremental build instead. Turn switching off with `"schemata": false`.

Everything happens in a copy of the project with its own `target/` folder; the
project is never changed. That copy is a **persistent session** under
`<cache>/rust-sessions/` in the per-user cache folder (`CUPEL_CACHE_DIR`): the second run in a project skips the cold
dependency build, and skips each test target's unmutated baseline (and switches-off
check) whose executable and test names are unchanged. The timing line reports
`session warm` and `baselines reused n/m`. The sessions of all projects share a disk cap
of 10 GB (`runners.cargo.mutants.sessionCapGB`, least recently used removed first);
`cupel clean --rust-sessions` removes them all (`--project`: this project's) and `"session": false` goes back to a
throwaway copy. CI that starts empty gets no benefit unless it caches
the session cache folder. cargo-mutants must still be installed: Cupel
uses its fault list.

## Slicing across CI machines

Fault testing splits cleanly: every fault is independent. Cupel plans, runs one
slice and merges; your CI starts the machines, hands each its slice, moves the
files and retries. Cupel never starts a machine or uses the network.

**Decide with the estimate.** Collect once, then ask for the plan:

```sh
cupel report --no-mutation --out .cupel/collected.json
cupel mutate --input .cupel/collected.json --plan --reuse .cupel/main.json
```

For each runner the plan shows the faults to run, reused and skipped, an estimate
of the fault-testing time, and the suggested number of slices. The estimate uses
each fault's measured time from the `--reuse` file when present (every run records
`durationMs` per fault), and otherwise the measured durations of the tests the
fault would run.

**The default rule**, per runner:

- if the estimate (divided by the processes one machine runs at once) fits the
  target time, **one machine**;
- otherwise **⌈time ÷ (target − startup)⌉ slices**, at most `--max-shards`.

Defaults: target 10 minutes (`--target-minutes`), 60 seconds of startup per
machine (`--startup-seconds`, measure yours), at most 20 slices; `--cores` is the
CI machine's core count. Most JavaScript, TypeScript and Python suites need one
machine: slicing them only adds startup time and cost. Rust usually benefits most,
because each fault needs a build. In a mixed repository, only the runners that
need slices get them.

**Run the slices** (the same `--input`, config and `--reuse` file on every machine):

```sh
cupel mutate --input .cupel/collected.json --runner cargo --shard 3/8 --reuse .cupel/main.json --out slice-3.json
cupel mutate --input .cupel/collected.json --runner node --reuse .cupel/main.json --out node.json
```

**Merge** the slices and whole runs into one input, then guard or audit it:

```sh
cupel merge-mutations --input .cupel/collected.json --out .cupel/head.json node.json slice-*.json
cupel guard --base-input .cupel/main.json --head-input .cupel/head.json
```

Merge refuses anything that does not fit: a different collected input, slices from
different plans, a missing or doubled slice, or a fault in two slices. Every
machine must compute the same plan, so use the same input, config, Cupel version
and `--reuse` file everywhere. A GitHub Actions sketch:

```yaml
jobs:
  plan:
    outputs:
      slices: ${{ steps.plan.outputs.slices }}
    steps:
      # checkout, toolchains, restore .cupel/main.json from the main-branch cache
      - run: cupel report --no-mutation --out .cupel/collected.json
      - id: plan
        run: |
          cupel mutate --input .cupel/collected.json --plan --runner cargo --reuse .cupel/main.json --json > plan.json
          echo "slices=$(jq -c '[range(1; .runners[0].suggestedShards + 1)]' plan.json)" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@v4
        with: { name: collected, path: .cupel/collected.json }
  rust:
    needs: plan
    strategy:
      matrix:
        index: ${{ fromJSON(needs.plan.outputs.slices) }}
    steps:
      # checkout, toolchains, the same .cupel/main.json, download the collected artifact
      - run: cupel mutate --input .cupel/collected.json --runner cargo --shard ${{ matrix.index }}/${{ strategy.job-total }} --reuse .cupel/main.json --out slice-${{ matrix.index }}.json
      - uses: actions/upload-artifact@v4
        with: { name: 'slice-${{ matrix.index }}', path: 'slice-${{ matrix.index }}.json' }
  merge:
    needs: rust
    steps:
      # download every slice artifact and the collected input
      - run: cupel merge-mutations --input .cupel/collected.json --out .cupel/head.json slice-*.json
```

### Sharing one build between slices

With the Rust `backend: "cupel"`, prepare the whole fault plan once and archive
the persistent session rather than making every slice start from a cold build:

```sh
DIR=/opt/cupel-cache
cupel mutate --input .cupel/collected.json --runner cargo \
  --prepare --cache-dir "$DIR" --json > prepared.json
tar -C "$DIR" -cf rust-sessions.tar rust-sessions

# Each slice restores at the same absolute path.
mkdir -p "$DIR"
tar -C "$DIR" -xf rust-sessions.tar
cupel mutate --input .cupel/collected.json --runner cargo \
  --shard "$INDEX/$TOTAL" --cache-dir "$DIR" --out "slice-$INDEX.json"

cupel merge-mutations --input .cupel/collected.json \
  --out .cupel/head.json slice-*.json
```

Every job needs the same OS image, toolchain, Cupel/config/flags, absolute
checkout path and absolute cache path. Transfer `rust-sessions.tar` with mtimes
preserved: Cargo uses them for freshness, while zip-based artifact uploads may
not preserve them. An OS, toolchain, Cupel/config/flags or checkout mismatch
changes the session id, so Cupel falls back to a new cold build. If Cupel selects
a restored session folder but its recorded project or cache path differs, it
refuses the moved bundle because compiled tests can embed paths such as
`CARGO_MANIFEST_DIR`. The timing line/JSON says `prepared true` and reports the
baseline and switches-off reuse counts when a slice reused the prepared verdicts.

## What is not done, and why

- **Stopping at the very first catch.** It would save a little more, but Cupel
  would no longer know whether a test is the only one that catches a fault, and
  then it could not tell you which tests protect something no other test does.
- **Testing groups of faults together.** Most faults are caught, so a group would
  almost always fail and have to be split again.
- **Re-collecting coverage only for changed tests.** This is how a suite can look
  green while missing something; Cupel's experimental selective mode keeps it
  separate and never lets it approve a whole suite.

**Rust sessions and `--out`/`--reuse` files:** the persistent Rust build session reuses its baselines only when the whole project is unchanged, and a report or reuse file inside the project counts. Keep `--out` and `--reuse` files under `.cupel/` (never copied or digested) or outside the project so they do not stop reuse.
