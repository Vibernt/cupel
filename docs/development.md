# Development checks and evidence

Read [CONTRIBUTING](../CONTRIBUTING.md) and the [support matrix](support.md) first.
The JavaScript source runs directly on Node 22+, without a build or product npm
dependencies. Runner fixtures and artifact tooling are separate prerequisites.
Never install tools implicitly after a failing test or treat a skip as acceptance.

## Everyday checks

From the repository root:

```sh
npm run -s check
node --test packages/cupel/test/release-support.test.mjs
npm test
npm run -s test:py
npm run -s test:ruby
```

Choose the relevant test file while iterating; `npm test` is the whole Node
suite. `npm run verify` runs the rule checker, Node, Python and Ruby suites in
that order and is required before a commit to `main`. The local pre-push hook
also runs it. GitHub Actions runs the larger hosted matrix below.

`test:py` uses `python3 -m unittest` on POSIX and `python -m unittest` on Windows.
Actual pytest fixtures additionally need
Python 3.12+ and pytest; some tests currently use the maintainer's read-only
CodeCrystal Python environment. `test:ruby` requires Minitest when Ruby is
available; it explicitly skips if Ruby is missing. Inspect output for skips.
No test may modify the read-only reference repositories.

The full Node suite also exercises native mutation and installed artifacts.
The restricted Rust path currently requires the fixed Homebrew Rust/Cargo 1.97.1
and matching LLVM tools on `aarch64-apple-darwin`; it is not an optional portable
integration. Selective package tests need Node 26.7.0 even when the test host is
Node 22. Set `CUPEL_PR_NODE` to its absolute executable before those runs.
Do not claim a complete full-suite pass on a host missing these requirements.

## Hosted CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, manual
dispatches and a nightly schedule. Its `test` job covers Ubuntu, macOS and
Windows with Node **22.23.3** and **26.7.0**. Matrix failures do not cancel the
other jobs; superseded pull-request runs are cancelled. The workflow has
read-only repository contents permission and uploads `.scratch` test output
when a job fails.

Each job prepares Go **1.27.1**, Ruby **4.0.7** with Minitest **6.0.0**, Python
**3.14** with pytest **9.1.1** and setuptools **80.9.0**, rustup Rust/Cargo
**1.97.1** with `llvm-tools-preview`, cargo-mutants **27.1.0**, Jest **30.2.0**,
Vitest **4.1.11** and **5.0.1**, TypeScript **5.9.3**, React **19.2.0**, and
Miniflare **5.0.0**. cargo-mutants is cached per OS and architecture. Python's
package-smoke environment and complete pytest wheel folder are prepared before
tests; installed-package validation itself remains offline.

CI runs `npm run -s check`, the full Node suite, the Python unittest and Ruby
suites, the pytest runtime suite, and the installed npm/Python package smoke.
It sets these acceptance gates so a missing prerequisite fails instead of
silently becoming acceptance:

- `CUPEL_REQUIRE_NATIVE_MUTATION=1` for exact Go and Ruby CLI fixtures;
- `CUPEL_REQUIRE_JEST=1` for the Jest runtime fixture;
- `CUPEL_REQUIRE_PACKAGE_SMOKE=1`, `CUPEL_REQUIRE_RUBY_SMOKE=1` and
  `CUPEL_REQUIRE_GO_SMOKE=1` for installed-artifact acceptance.

The workflow exports `CUPEL_TEST_NODE22`, `CUPEL_TEST_NODE26` and
`CUPEL_PR_NODE` (Node 26), `CUPEL_CARGO_MUTANTS`, `CUPEL_TEST_MINIFLARE`,
`CUPEL_TEST_PYTHON`, `CUPEL_PACKAGE_PYTHON`, `CUPEL_PACKAGE_WHEELS`,
`CUPEL_JEST_MODULES`, and
`CUPEL_TEST_VITEST4_MODULES` / `CUPEL_TEST_VITEST5_MODULES`. The Vitest
variables replace the maintainer-only CodeCrystal dependency paths in CI; when
unset, those read-only paths remain the local defaults.

The restricted `backend: "cupel-rust"` integration is the only host-profile
availability skip. It runs solely with Homebrew Rust/Cargo **1.97.1** on
`aarch64-apple-darwin`; rustup 1.97.1 is deliberately not equivalent. Set
`CUPEL_REQUIRE_RESTRICTED_RUST=1` on the maintainer's matching machine so an
absent or drifted profile fails. Hosted CI does not set that flag. This does not
hide portable failures: rustup coverage and cargo-mutants gates still run, and
Linux or Windows failures remain failures. The Go mutation process runner is
POSIX-only by contract today, so its native Windows cases are expected to expose
that limitation rather than establish Windows mutation acceptance.

For changes that spawn Node or use newer Node APIs, also run Node tests on Node
22. On the maintainer's machine, with Node 26.7.0 prepared separately:

```sh
CUPEL_PR_NODE=/opt/homebrew/bin/node \
  PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
```

Check that the selected executables have the required versions. This verifies
the Node 22 host with the explicit Node 26 experiment executable; it
does not enable selective execution on Node 22.

## Runner fixtures

| Tooling | Ordinary run behavior | Required acceptance |
| --- | --- | --- |
| Jest fixture | Actual-runtime cases skip when its dependencies are absent. | Prepare the lockfile with `npm ci --prefix spec/conformance/adapters/jest`, then run `CUPEL_REQUIRE_JEST=1 node --test packages/cupel/test/jest-runtime.test.mjs`. This explicit dependency preparation may use the npm registry; Cupel does not perform it. |
| Vitest fixtures | Cases skip if the exact local Vitest/TypeScript dependencies are missing. They use `CUPEL_TEST_VITEST4_MODULES` and `CUPEL_TEST_VITEST5_MODULES`, defaulting to the maintainer's read-only CodeCrystal `node_modules`. | Both tested versions, 4.1.11 and 5.0.1 must execute. Hosted CI prepares and points at both trees; there is no single required-fixture flag, so inspect outcomes and do not count skips as acceptance. |
| Python fixtures | Static tests run; actual-runtime tests use `CUPEL_TEST_PYTHON`, defaulting to the maintainer's read-only CodeCrystal Python. | Require the actual fixture cases to run with Python 3.12+; hosted CI prepares Python 3.14 / pytest 9.1.1 and points the tests at it. |
| Go/Ruby mutation | Some native CLI cases skip without exact Go 1.27.1 or MRI 4.0.7 / Minitest 6.0.0. | `CUPEL_REQUIRE_NATIVE_MUTATION=1` makes those CLI prerequisite checks fail. |
| Rust mutation | Portable rustup coverage and cargo-mutants cases use the prepared tools. The restricted backend skips with its exact missing-profile reason. | The exact Homebrew host/toolchain profile in [Rust limits](rust.md), with `CUPEL_REQUIRE_RESTRICTED_RUST=1`, is required for restricted-backend acceptance. |

Missing tooling must be reported and prepared explicitly. No alternate runtime,
reduced inventory or coverage-only mode establishes the missing gate.

## Installed artifact gates

Run the actual npm tarball/Python wheel smoke after preparing its tools:

```sh
CUPEL_REQUIRE_PACKAGE_SMOKE=1 \
CUPEL_REQUIRE_RUBY_SMOKE=1 \
CUPEL_REQUIRE_GO_SMOKE=1 \
CUPEL_REQUIRE_RESTRICTED_RUST=1 \
CUPEL_PR_NODE=/opt/homebrew/bin/node \
node --test scripts/package-smoke.test.mjs
```

The Node 26 path above is specific to the maintainer's setup. The npm smoke packs
and installs offline, checks version/MIT/private metadata and packaged assets,
and runs CLI/MCP plus runner positive/negative controls. Restricted Rust
acceptance requires the exact native profile and gate above. The experimental
selective checks remain outside the supported first release despite being
included in local regression testing.

`CUPEL_REQUIRE_PACKAGE_SMOKE=1` requires both prepared Python package tools and
the Jest runtime. Defaults are:

- `.scratch/package-tools/runtime/bin/python`, with setuptools **80.9.0**, pytest **9.1.1** and pip;
- `.scratch/package-tools/wheels`, containing pytest and its complete offline dependency wheels;
- `.scratch/jest-runtime/node_modules`, containing Jest **30.2.0**.

Set `CUPEL_PACKAGE_PYTHON`, `CUPEL_PACKAGE_WHEELS` and `CUPEL_JEST_MODULES` to use
explicitly prepared locations. These tests never download or replace missing
tools. Without the gate flags, Python can skip and Jest/Go/Ruby can return
blocked/skipped results inside the smoke; inspect `result.json` and
`python-result.json`, not only the top-level Node test count.

Each invocation creates a fresh `.scratch/package-smoke/run-*/` and preserves
prior outputs. Do not delete accepted handoffs or replace a stable installation
without recording the new artifact hash and verification. Artifact, source,
runner fixture, real-repository and hosted enforcement evidence are distinct.

## Documentation checks

```sh
node --test packages/cupel/test/release-support.test.mjs \
  packages/cupel/test/release-support-source.test.mjs
```

These check support tiers, accepted evidence, current source/licence guidance,
local documentation links and CLI/MCP scope wording. Package smoke tests cover
the documented local install path. Documentation checks do not establish a
new real-repository runner acceptance or live GitHub enforcement.
