# Handoff: where Cupel stands and how to resume

Updated 2026-11-24. Read this first when picking the work up again; then
`AGENTS.md` (rules), `plans/DECISIONS.md` (why) and the release records in
`plans/results/` (evidence).

## Current state

- **Version:** npm package `@vibernt/cupel` **0.5.2**, Python collector `vibernt-cupel` **0.4.0**.
- **`main`:** merge of Vibernt/cupel#4 (the README and diagrams). Tags `v0.1.0`–`v0.4.0`. GitHub releases with the npm tarball for
  `v0.3.0` and `v0.4.0`; the asset's SHA-256 is in each release note and record.
- **Not published to npm or PyPI.** npm keeps `"private": true` and Python `Private :: Do Not Upload`; any registry
  upload needs the owner's explicit approval in chat (L6).
- **Spec:** `cupel-spec/1`, 114 conformance cases (`node spec/conformance/build.mjs` regenerates them).
- **Verified on macOS only.** Linux and Windows are untested for the 0.2–0.4 features.

## What each version added

| Version | Highlights | Record |
| --- | --- | --- |
| 0.2.0 | `cupel audit` (six questions, rules U1–U7, MCP `cupel_audit`); Rust coverage on any OS; Rust fault testing through cargo-mutants (D19); `no-assertion` and `tautology` findings for Rust, JS/TS and Python; per-test coverage and fault testing of Worker code in workerd (D18, spike S30); `builtInto` and opt-in `crossRunner` for mixed-language repositories; `guard --allow-runtime-change` | [0.2.0](results/2026-11-23-0.2.0-candidate.md) |
| 0.3.0 | Reuse of earlier fault results with a fingerprint per fault (K15, D20); pytest stops once two units caught a fault; Rust skips lines no test runs, tests only the packages that run the code, honours `maxMutants`; `guard --out`, `guard --base-input … --changed`; `docs/speed.md`, `docs/best-practices.md` | [0.3.0](results/2026-11-23-0.3.0-release.md) |
| 0.4.0 | Cupel's own Rust fault runner `backend: "cupel"` (D21): only covering test targets and tests, ordered by the input, stop after two, switchable faults in one build with per-target trust; CI slices `mutate --plan`, `--runner R --shard I/N`, `merge-mutations` (D22); guard heads stop at the first catch (D23, rule I6); `durationMs` per fault | [0.4.0](results/2026-11-23-0.4.0-release.md) |
| 0.5.0 | Rust build sessions in the per-user cache with reuse of unmutated passes (D24); opt-in whole-function variants and verify mode (D25); `mutate --prepare` CI slices, `sessionEnvIgnore` (D26); likely catchers first in every runner (D27); Go covering-only selection, stop after two and a switched build; Ruby stop after two (D28); Python collector 0.4.0 | [0.5.0](results/2026-11-25-0.5.0-release.md) |
| 0.5.1 | Runners sharing a source combine their mutant rows (issue 7, K14); hosted CI setup fixes | [0.5.1](results/2026-11-26-0.5.1-release.md) |
| 0.5.2 | Sources a runner cannot measure (JSX under node:test, unreadable files) listed apart and counted in reports; `.d.ts` files are not sources (issue 9, K2, R3) | [0.5.2](results/2026-11-27-0.5.2-release.md) |
| README | Rewritten for 0.4.0; diagrams are code (Fire components) rendered by `scripts/render-readme-art.mjs` | [docs/assets/README.md](../docs/assets/README.md) |

## Decisions to know (details in DECISIONS.md)

- **D18** Loopback to workerd's inspector is the one network use, for Worker coverage.
- **D19** Rust fault testing imports cargo-mutants by default; Cupel never downloads it.
- **D20** Reuse only on an unchanged fingerprint; `guard`, `check` and `mutate` reuse only a file named with `--reuse`
  (an in-tree `.cupel/input.json` could come from the change under review).
- **D21** `backend: "cupel"` runs cargo-mutants' faults itself; cargo-mutants stays the default.
- **D22** Slices: Cupel plans, runs one and merges; CI starts machines. Default rule: one machine while the estimate
  fits 10 minutes, else ⌈time ÷ (target − startup)⌉ slices per runner, at most 20.
- **D24–D28** (0.5.0) Rust sessions in the user cache, reuse only when nothing changed; variants opt-in with
  verify mode; prepared CI slices; likely catchers first from inputs only; Go switched build and Go/Ruby stop rules.
- **D23** Guard's head stops at the first catch; such input (`mutation.catches: "first"`) is refused everywhere
  except as guard's head (I6).
- Throughout: Cupel never changes or deletes the assessed project's tests or code and never advises deleting a test.

## Where the code is

| Area | Files |
| --- | --- |
| Engine (pure, no I/O) | `packages/cupel/src/engine/` (`audit.mjs`, `commands.mjs`, `integrity.mjs`, `index.mjs` for I6) |
| JS mutation, plans and slices | `packages/cupel/src/mutate/index.mjs` (`planOrSlice`, `STOP_AFTER_FILES`), `reuse.mjs` (K15) |
| Rust | `packages/cupel/src/mutate-cargo/`: `run.mjs` (cargo-mutants, plan, slices), `fast.mjs` (backend cupel), `schemata.mjs` (switchable faults), `import.mjs` (`attributeOutcomes`, shared credit) |
| Python | `packages/cupel-py/src/vibernt_cupel/mutation_run.py`, `mutant.py` (early stop, plan, `only`, `durationMs`) |
| CLI | `packages/cupel/src/cli/`: `collect.mjs` (mutate/confirm wrappers, reuse, runner parts), `main.mjs`, `collection-commands.mjs` (`mutate`, `merge-mutations`), `shard.mjs` (rule, assignment, merge) |
| workerd | `packages/cupel/src/collect/node/workerd.mjs`, `workerd-ranges.mjs` |

## How to test

- Quick: `node scripts/check.mjs`, then the test files you touched (`node --test packages/cupel/test/<file>.test.mjs`).
- Full: `node --test "packages/cupel/test/**/*.test.mjs" "scripts/**/*.test.mjs" "bench/**/*.test.mjs"` and the Python
  tests in `packages/cupel-py/tests`. Live Rust and workerd tests run when these are set:
  `CUPEL_CARGO_MUTANTS` (a cargo-mutants binary), `CUPEL_TEST_MINIFLARE` (a `package.json` with Miniflare installed),
  `CUPEL_TEST_NODE26` (a Node 26.7.0 binary), and LLVM tools on `PATH`.
- On a machine without Node 22.23.3, Go 1.27.1, Ruby 4.0.7 with Minitest 6, the Vitest fixtures' packages and Homebrew
  Rust 1.97.1, the same 31 tests fail; compare failing test names with that list instead of expecting zero. The
  pre-push hook (`npm run verify`) then fails too: pushing with `--no-verify` needs the owner's say-so each time.
- Go 1.27.1 (go.dev archive, checked against its published SHA-256) and Ruby 4.0.7 (built from the ruby-lang.org
  tarball, which bundles Minitest 6.0.0) can live under `.scratch/tools/` (ignored by git); put their `bin` first on
  `PATH` with `CUPEL_REQUIRE_NATIVE_MUTATION=1` to run the live Go and Ruby tests instead of skipping them.

## How to release (owner approval each time)

1. Bump `packages/cupel/package.json` and, if Python changed, `packages/cupel-py/pyproject.toml`; update the version in
   `README.md`, `docs/install.md` (tarball and wheel names), `docs/private-use.md`, `docs/support.md`, `CONTRIBUTING.md`,
   and the expectations in `packages/cupel/test/release-support.test.mjs`, `scripts/package-smoke.test.mjs` and
   `scripts/package-metadata.test.mjs`.
2. Write `plans/results/<date>-<version>-release.md` (what is new, evidence, not verified) and add the owner's
   approval paragraph to `plans/DECISIONS.md`.
3. Merge to `main`, tag `vX.Y.Z` on the merge commit, then build the tarball twice from `git archive vX.Y.Z` with
   `npm pack --offline --ignore-scripts ./packages/cupel` and check both hashes match; install it offline and run
   `--version`.
4. `gh release create vX.Y.Z <tarball> --verify-tag` with notes stating the SHA-256 and what is verified.

Keep private projects' names, paths and findings out of this public repository; describe them generically.

## Open items

- Linux and Windows runs of the 0.2–0.4 features.
- A timed cargo-mutants run on the same input as the 0.4.0 Rust measurements (the 3-hour figure is an estimate).
- Slices on a real CI system; sharing one switched Rust build between slices (each slice builds its own today).
- Worker code bundled or compiled from TypeScript: map through source maps (now reported as not measured);
  tests running inside workerd (`@cloudflare/vitest-pool-workers`) are not supported.
- `crossRunner` end to end on a real project.
- In the switched Rust build, a faster switch check (time-budget tests currently fall back to per-fault builds) and
  regrouping operator faults rendered exactly (they get their own build today).
- Real-repository acceptance as a recorded gate for Rust and workerd.
- npm and PyPI publication: not approved.
