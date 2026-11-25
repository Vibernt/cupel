# Plan: Rust speed ideas in the other runners (2026-11-25)

Owner request: bring Go and Ruby up to what JavaScript and Python already do, add catch-history and
same-file order everywhere, and build a Go version of the shared switched build. Built as parallel Codex
tracks, reviewed and integrated by the lead on branch `lang-speed` (on top of `rust-reuse`).

| Track | Branch | What changed | Verified |
| --- | --- | --- | --- |
| Go parity | `go-parity` | Only covering packages and tests (`-run`), input-only package order (catch history, `foo_test.go` package, coverage count, input time, name), stop after two catching packages (one with first-catch), per-selection baselines, K15 reuse only when the basis holds every test file Go compiles | Go 1.27.1: all Go tests; live test "selective runner matches a full-module run with fewer Go commands" |
| Go switched build | `go-switch`, `go-wire` | Whole-function body variants in one overlay build, stable numbers over all sites of the files in scope, package helper file, switches-off check per package, fallback to individual builds with reasons, `CUPEL_GO_VERIFY_SWITCHED=1`, `mutate-go: timings`, `runners.go.mutants.schemata: false` | Go 1.27.1: identical rows switched vs individual; verify mode; fixture 3.9 s to 2.8 s and `go test -c` calls 4 to 1 |
| Ruby parity | `ruby-parity` | Stop after two catches (one with first-catch), catch-history then same-name test file order; a reported failure beats a later error or timeout | MRI 4.0.7 + Minitest 6.0.0: all Ruby runtime tests (38 runs) and the Ruby CLI tests |
| JS/TS and pytest order | `order-js-py` | Catch history, then the fault's own test files (`b.test.ts`, `__tests__`, mirrored `test/`; `test_b.py`, `b_test.py`) | JS and Python unit tests; existing fixture statuses unchanged |

Measured: the unmutated baseline pass is 8% of a JavaScript fixture run and 29% of a Python one, so
persisting baselines is worth doing for Python first.

Open:
- Ruby reuse stays off: the reuse basis does not identify installed gems or Bundler/Gem path settings.
- Go: one compile-invalid variant sends its whole package to individual builds (Rust drops only the failing
  faults and retries); a real Go repository benchmark is not done.
- The npm package smoke stops at its Rust step on this Mac (pinned Homebrew Rust 1.97.1 is not installed),
  before its Go and Ruby steps, also on the branch before this work.
- Toolchains for local checks: `.scratch/tools/go-1.27.1` (sha256 verified from go.dev) and
  `.scratch/tools/ruby-4.0.7` (built from the sha256-verified ruby-lang.org tarball; bundles Minitest 6.0.0).
