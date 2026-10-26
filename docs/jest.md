# Jest 30.2.0 adapter

**Core full guard**, within the [support matrix](support.md). Actual-runtime
fixtures, installed CLI/MCP and **real-repository ordinary Jest acceptance
passed**. The [pinned jest-junit evidence](../plans/results/2026-10-26-jest-acceptance.md)
retains all 51 original tests / 4 files, original one-project Node config with
`transform:{}`, and documented `NODE_OPTIONS=--experimental-vm-modules` for its
dependency setup. Both fresh live Git guard controls have exact installed
CLI/MCP report parity; a passing weakened assertion loses one credited kill.
The separate 51 + 2 source-pin controls receive zero kill credit. This real CJS
lane complements the existing TypeScript fixtures; native ESM tests and arbitrary
third-party transforms remain unsupported. Jest selective PR execution is
unsupported and outside the supported first release.

Cupel uses the project's installed Jest. The verified combination is exactly
`jest`, `jest-circus`, and `jest-environment-node` 30.2.0, with one Jest project
and the Node test environment. Cupel adds no Jest product dependency.

Run `cupel report --runs 2` from the project. The adapter reads Jest's effective
config, lists files with Jest, runs the suite twice in separate processes, and
uses a custom Node environment to record V8 precise coverage from setup,
`beforeEach`, body, and `afterEach`. Overlapping concurrent intervals go to
every active test. The two runs are united and variable lines are marked
`coverage.unstable`. Requested rechecks use fresh processes and select exact
IDs, including a single duplicate-name occurrence. Mutants are given to a
wrapper before the project's transformer; source text travels in process
memory, and Jest's disk cache is disabled. Cupel never writes mutant source or
transformed mutant files.

`runners.jest.env` is supported. This verified adapter rejects
`runners.jest.command`, `tests`, `prepare`, and `project` rather than ignoring
them. It also rejects other Jest versions, a custom or per-file environment,
non-circus runners, multiple Jest projects, native ESM test files, worker-thread
tests, parameterized registrations from helper modules, and transformed sources
without an inline map back to the original source. A mapping or result mismatch
is an environment error; no partial input is returned. The project's own
setup files, mocks and transforms remain in its effective Jest configuration.

The actual-runtime fixture is in
`spec/conformance/adapters/jest/`. Install its test-only dependencies with
`npm ci --prefix spec/conformance/adapters/jest`, then run
`CUPEL_REQUIRE_JEST=1 node --test packages/cupel/test/jest-runtime.test.mjs`.
This is a release gate; ordinary test runs explicitly skip these cases when
the fixture has not been installed. The fixture pins Jest and TypeScript to
exact versions and does not add dependencies to `@vibernt/cupel`.
