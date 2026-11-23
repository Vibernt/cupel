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
| **Only the tests that run the line** | A fault on line 40 is tested only with the tests whose coverage includes line 40. Other tests cannot notice it. | node:test, Vitest, Jest, pytest. Rust: by package (below) |
| **Most relevant, fastest tests first** | Test files that run the line most come first, then the quickest. | node:test, Vitest, Jest |
| **Stop once the answer is known** | A fault stops running after two different tests (two test files in JavaScript, two units in Python) have caught it. Two, not one, so Cupel still knows whether a test is the only one that catches it. A unit that a review is asking about always gets every test run. | node:test, Vitest, Jest, pytest |
| **Time limits from measured times** | Each test file (or pytest selection) is first run once unmutated. A fault run may take three times that, with a floor of one second; a run that times out is retried once with a longer limit before it counts as a timeout. | node:test, Vitest, Jest, pytest; cargo-mutants sets its own limits from its baseline |
| **Skip what no test runs** | A fault on a line no passing test runs is reported as `no-coverage` without being run. For Rust this saves a full build and test run per fault. | node:test, Vitest, Jest, pytest, Rust |
| **Only the Rust packages whose tests run the code** | When the tests that run the faulty lines all live in some workspace packages, only those packages' tests run, plus the package that owns the faulty file (`--test-package`). A test elsewhere does not run the line. If Cargo features change when one package is built alone, set `wholeWorkspace`. | Rust (cargo-mutants) |
| **Reuse earlier answers** | A fault whose code, covering tests and everything those tests read are unchanged since the last run copies its earlier result. See [Reuse](#reuse-earlier-results). | node:test, Vitest, Jest, pytest, Rust (cargo-mutants). Go, Ruby and the restricted Rust backend record fingerprints but run every fault |

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
| `runners.cargo.mutants.jobs` | 1 | Rust faults built and tested in parallel. Each job needs its own build and memory. |

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

## What is not done, and why

- **Stopping at the very first catch.** It would save a little more, but Cupel
  would no longer know whether a test is the only one that catches a fault, and
  then it could not tell you which tests protect something no other test does.
- **Testing groups of faults together.** Most faults are caught, so a group would
  almost always fail and have to be split again.
- **Re-collecting coverage only for changed tests.** This is how a suite can look
  green while missing something; Cupel's experimental selective mode keeps it
  separate and never lets it approve a whole suite.
- **One build for many Rust faults** (all faults compiled into one program and
  switched on one at a time). It would remove most of Rust's cost but is a large
  project; it is not built yet.
