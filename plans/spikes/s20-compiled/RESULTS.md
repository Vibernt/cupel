# S20 compiled-language source substitution proof

## Question and method

Can a Go or Rust test binary execute a changed production function while a test that reads the source file still sees the unmodified file? This is a feasibility proof for mutation. It does not change the Go or Cargo collectors, define mutation operators, or establish safe selective PR execution.

Run `node --test plans/spikes/s20-compiled/go.test.mjs plans/spikes/s20-compiled/rust.test.mjs` from the repository root. The two `node:test` cases create fresh outputs below ignored `.scratch/s20-compiled/`. Both hash the original production source before and after. Fixture packages have no third-party dependencies. The process environment is explicit and contains no inherited credentials: Go uses `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, `CGO_ENABLED=0`, and scratch caches; Cargo uses `--offline`, `CARGO_NET_OFFLINE=true`, scratch Cargo home and target directories. Separate fixture test filters isolate behavior failures from source-pin results; they are not a fallback for a failing or resource-limited suite. No installation, download, network access, external mutator, or larger heap was used.

Toolchains observed on 2026-10-25: Go **go1.27.1 darwin/arm64**, Rust **rustc 1.97.1** (`8bab26f4f`, Homebrew), Cargo **1.97.1** (`c980f4866`, Homebrew), Node **v26.7.0**. Go's local `go help build` documents `-overlay` as a compile-time replacement and says overlays do not appear when tests run. The installed `rustc -v --help` lists path remapping but no source overlay option.

## Evidence

| Probe | Behavior test | Source and path pins | Original source SHA-256 |
|---|---|---|---|
| Go baseline `go test` | Pass, returns 1 | Disk source pin passes | `10a0dc47c7e2995328827010c96fa79f18a59543f05f1c5e977aa591ac95b0e9` before and after |
| Go `go test -overlay` with scratch `return 2` | Fails with `value() = 2, want 1` | `os.ReadFile("value.go")` pin passes | Same |
| Rust baseline `cargo test --offline` | Pass | Five runtime, `include_str!`, `include_bytes!`, and `file!` pins pass (6/6 tests total) | `632113841bd79e70edf55effc2b18f83e2879f96c55281b5d4a2cf31a5b9f5ce` before and after |
| Rust direct `rustc --test` on scratch `lib.rs` containing `return 2` | Fails | Runtime and manifest-absolute pins pass; relative `include_str!`, `include_bytes!`, and `file!` pins fail because source bytes/path changed | Same |
| Rust direct `rustc --test` on scratch `mutant.rs`, pristine `lib.rs` symlink | Fails | Relative inclusion pins pass; `file!` path pin fails | Same |
| Rust scratch `mutant.rs` plus pristine symlink and `--remap-path-prefix` | Fails | All five pins pass | Same |
| Rust Cargo `RUSTC_WRAPPER` using that scratch root and remap | Fails with mutant value 2 | All five pins pass under Cargo | Same |

The last two Rust rows establish a **single-file crate-root primitive**, not general Rust mutation support. The wrapper substitutes Cargo's crate-root argument only. It does not redirect non-root module loads or prove equivalence for `mod`, `#[path]`, `include!`, generated files, build scripts, procedural macros, macro-generated paths, compile-time file or environment reads, target-specific `cfg`, or dependencies. The direct scratch `lib.rs` rows are a concrete false-kill counterexample if path/inclusion handling is omitted. A general Rust mutation claim requires a representative multi-file and macro matrix with refusal for unsupported constructs; no such gate was run here.

## Feasibility and selective execution

| Language | Mutation source substitution | Selective PR execution |
|---|---|---|
| Go | **Feasible primitive**: `-overlay` changed compiled behavior, while runtime source read saw pristine disk. Product operator, validity, and conformance cases remain to implement. | **Unproven**. Per-test line coverage alone does not close runtime file I/O, package initialization, dynamically named subtests, generated/build-tag files, native subprocesses, or order/shared-state dependencies. |
| Rust/Cargo | **Fixture-limited primitive**: scratch crate root, pristine symlink, path remap and `RUSTC_WRAPPER` passed the source-pin controls. General source graph safety is not established. | **Unproven**. Cargo build scripts, macros, feature/cfg changes, module reads, native I/O and shared state need explicit dependency capture or refusal. |

The requested Rust **language** work is distinct from a Rust **engine port**. This proof investigates mutation execution for Rust tests. It does not port Cupel's deterministic engine to Rust and provides no evidence that such a port improves latency or memory. The existing Go and Cargo collectors still produce no mutation data; absence must remain unknown.

## Verdict and next action

Implement the first native mutation slice for **Go**: a bounded deterministic operator and site model, compile via `-overlay` without modifying source, run the relevant complete package test binary, classify only assertion failures as kills, and add negative cases for a source-text pin, invalid mutant, compile failure, and unchanged source hash. Measure whole-call cost only after correctness. Keep Rust mutation out of product claims until a multi-file Cargo source-graph proof handles or explicitly refuses every path and macro case above. Selective PR mode for either language needs separate safety matrices including native I/O and shared state; these fixtures establish no universal safety or speed result.

Tests added: the two proof smoke tests and both no-dependency language fixtures. `node --test plans/spikes/s20-compiled/go.test.mjs plans/spikes/s20-compiled/rust.test.mjs` passed **2/2** on Node 26.7.0. The same command with `/opt/homebrew/opt/node@22/bin/node` passed **2/2** on Node 22.23.3; the scratch Rust wrapper's shebang resolved `/opt/homebrew/bin/node` in both runs. Product Go/Rust mutation and selective PR paths have **no new test coverage** because they were not changed.
