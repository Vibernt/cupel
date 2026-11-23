# Rust collector

**Bounded preview**, within the [support matrix](support.md). Coverage runs on
any OS with a rustup toolchain and matching LLVM tools. Mutation runs through
the user's installed [cargo-mutants](https://mutants.rs) by default (D19).
**Real-repository acceptance is unrun** as a recorded gate: in the test-quality
audit plan, coverage has matched plain LLVM line for line on one private
workspace (5,828 lines), and mutation acceptance is in progress. Until it is
recorded, treat Rust results as preview evidence. Native selective PR
execution is unsupported.

## Coverage

Run `cupel collect-cargo --root DIR [--runs N] [--recheck UNIT…] [--out FILE] [-- cargo test args]`. Configure `runners.cargo` in `cupel.json` to select it for `report`, `check`, `guard`, `plan`, `label` and `review`. A configured `runners.cargo.tests` glob selects Cargo packages and test files and accepts brace alternatives; the direct CLI also accepts `--tests GLOB`. Cupel uses the user's Cargo and rustup environment without changing `CARGO_HOME` or `RUSTUP_HOME`. When `CARGO_TARGET_DIR` is set, builds use a repository-specific subdirectory inside it, so cached binaries from another checkout never attribute coverage to stale paths. Cargo is forced offline (`CARGO_NET_OFFLINE=true`, `--offline`): install dependencies first. A custom Cargo runner or build target (`.cargo/config.toml`, `--target`) is refused, because tests run directly on the host. The collector needs `llvm-profdata` and `llvm-cov` matching rustc's LLVM major version, from the rustup sysroot (`rustup component add llvm-tools-preview`) or from `PATH`; otherwise it exits 3 with that installation command.

How it runs:

1. **Build once.** `-C instrument-coverage` is appended to `RUSTFLAGS` and `cargo test --no-run --message-format=json --tests` builds every test binary and every workspace program the tests use (without a target choice of your own, `--tests` is what `cargo test` runs, minus doctests). Build scripts' and proc macros' profiles go to Cupel's scratch directory, never the project.
2. **Learn Cargo's environment.** One `cargo test ... -- --list` runs each test binary through a recording runner (`--config target.<host>.runner`). It records the working directory Cargo uses (the package directory) and the variables Cargo adds (`CARGO_MANIFEST_DIR`, `CARGO_PKG_*`, the dynamic-library path, `[env]` entries). Values you already had are never recorded or written anywhere. Every test then runs exactly as `cargo test` would run it, on macOS, Linux and Windows.
3. **One process per test.** Each test runs alone (`--exact NAME --test-threads=1`), two at a time, with its own `LLVM_PROFILE_FILE`. `#[should_panic]` and `#[ignore]` are read from the harness output (`ignored` is `skipped`). A test that aborts its process has failed and has no coverage.
4. **Export.** Profiles are merged with `llvm-profdata merge -sparse` and exported with `llvm-cov export` over the test binary **and every workspace program**, so a CLI that a test starts (`env!("CARGO_BIN_EXE_…")`) is covered by that test.
5. **Count everything.** Coverable lines come from one export over every test binary and program, so a crate with no tests, or a `main.rs` only tests start, counts in the denominator. A source under `src/` that defines functions but is compiled into nothing for this host (for example `#[cfg(target_arch = "wasm32")]` code) is listed with `unmeasured`, never as 0%.

`--runs` repeats the per-test run; line coverage is united across runs, and `coverage.unstable` holds lines present on some runs only. Each run contributes a duration.

**Line mapping.** LLVM export `segments` give one-based lines, byte columns, execution counts and a `hasCount` flag; each counted segment extends to the next one. Byte columns map to source characters; a line is coverable when a non-comment, non-whitespace character lies in a counted region, and covered when such a character has a positive count. Source scope is repository `.rs` files under a `src/` directory, including workspace crates, excluding `tests/`, `benches/`, `examples/`, `target/`, vendor and dot directories. Paths use `/` on every OS.

**Reading sources.** Only `.rs` files are read: hashed and scanned, never printed. A module called `secrets.rs` or a `credentials/` directory is ordinary Rust; key and credential files are never `.rs`, so they are never read. A symlinked or hard-linked `.rs` file is refused; other symlinks are not followed.

**Test ids and findings.** Ids are `<test source file>::<module > test name>`. Source scanning finds test functions with any run of attributes (`#[test]`, `#[tokio::test]`, `#[should_panic]`, `#[ignore]`, in any order), `// cupel:critical|standard|minor` tags on the line above, and four-token FNV-1a body shapes. Findings:

- `source-text` / `doc-wording`: the test asserts on text read from a source or document file (`include_str!`, `std::fs::read_to_string`).
- Ignored tests (`#[ignore]`) are not judged, and tests named for not panicking (`..._never_panics`, `no_panic_...`) need no assertion.
- `no-assertion`: the test checks nothing — no assertion macro, no `unwrap`/`expect`, no `?`, no `#[should_panic]`, no `Result` return, no check-named call, no same-file helper that checks. Reported only when that is certain: a custom macro or a call into `common::`, `helpers::` and similar test-helper modules suppresses it.
- `tautology`: an assertion that cannot fail, such as `assert!(true)`, `assert_eq!(x, x)` or `assert!(a == a)`.

## Mutation through cargo-mutants (default)

Install [cargo-mutants](https://mutants.rs) yourself (for example `cargo install --locked cargo-mutants`); Cupel never downloads it. `report`, `guard` and `check` then run it on the lines in scope (critical sources, changed lines, targeted units):

```json
{ "runners": { "cargo": { "mutants": { "command": "cargo-mutants", "jobs": 2, "args": ["--exclude-re", "impl Debug"] } } } }
```

All keys are optional: `command` defaults to `cargo-mutants` on `PATH`, `jobs` to 1. Cupel runs `cargo mutants --no-shuffle --test-workspace=true --cargo-test-arg=--no-fail-fast --in-diff <scope>` with output in its scratch directory. cargo-mutants mutates a copy of the project, never the project itself. Then Cupel:

- records **which tests caught each fault** from cargo-mutants' logs, and **how**: `assertion` when the failure came from the test's own code (an assertion, an unmet `should_panic`, a returned error), `panic` when the code under test panicked and the test merely ran it;
- re-runs every **timeout** once, alone, with ten times the limit, and keeps that result. A timeout never credits a test;
- gives **no credit** to a test that reads source text (K6: pins never earn kills);
- leaves out faults on lines the coverage input cannot count (code not built for this host), which cargo-mutants would otherwise call missed, and marks missed faults on lines no test covers as `no-coverage`;
- refuses results whose sources changed since the run, runs without `--no-fail-fast`, single-package test runs in a multi-package workspace (whatever the outcome), nextest logs (not readable per test yet), logs it cannot attribute, and catching tests the coverage input does not have;
- counts a fault caught by a test binary that crashed, or only by a timeout, as detected without crediting any test, and then no test whose lines hold it is treated as complete evidence (it is never called "catches nothing").

`cupel import --format cargo-mutants` reads a `mutants.out` you produced yourself, with the same rules (see the [CLI reference](cli.md)).

On Apple Silicon, an Intel-only cargo-mutants runs under Rosetta and its child processes inherit Intel; Cupel then starts Cargo natively so C build scripts target the right architecture.

## Restricted built-in mutator (`backend: "cupel-rust"`)

The earlier built-in mutator remains available with `"mutants": { "backend": "cupel-rust" }`. It is unchanged, accepts only the closed grammar below, and needs the fixed toolchain it was built against.

Rust mutation uses the fixed local Homebrew Rust/Cargo **1.97.1** tools on `aarch64-apple-darwin`. The backend runs the complete ordinary suite serially with `cargo test --offline --locked -- --test-threads=1`, requiring exact test-ID/status parity with collection before accepting a mutant. It uses fresh scratch Cargo/home/target directories and never downloads a toolchain or dependency. Source substitution happens only in scratch through a checked `RUSTC_WRAPPER` invocation; original sources remain unchanged. This establishes the stated serial profile, not parity with Cargo's default parallel scheduling.

The admitted input is one dependency-free ordinary library at `src/lib.rs`, edition 2021 or 2024, with at most 64 ASCII `.rs` files in a complete ordinary module graph. External `mod name;` declarations occupy isolated lines; external modules inside inline modules refuse. Every graph file, including test-only and nonexecuted files, requires a matching canonical raw `sha256:` input hash. Source, test, manifest and lock bytes and path identities are rechecked around every child process. The collector now records raw hashes for every safely inventoried `.rs` file; a file without LLVM executable regions has `coverable: ""`, without invented coverage.

The closed grammar accepts bounded functions, primitive/String/reference/tuple/array types, `let`, `return`, `if`, primitive expressions, calls, and methods. Its standard macro whitelist is `assert!`, `assert_eq!`, `assert_ne!`, the corresponding `debug_assert` forms, `panic!`, `println!`, `eprintln!`, `concat!`, `env!("CARGO_MANIFEST_DIR")`, `include_str!`, `include_bytes!`, `file!`, `module_path!`, `line!` and `column!`. Include macros name an original Rust basename in that source directory. The only native file readers admitted are direct `std::fs::read`/`read_to_string` calls naming a pinned graph source with a literal `"src/path.rs"` or `concat!(env!("CARGO_MANIFEST_DIR"), "/src/path.rs")`. Computed, external, missing and aliased read targets refuse. Other environment accessors refuse, including compiler-wrapper and receipt environment variables.

Unknown tokens and grammar refuse: dependencies, workspaces, Cargo configuration, custom compiler environment or runner behavior, build scripts, features/cfg, custom or procedural macros, `include!`, existing path attributes, generated files, doctests/documentation comments, raw strings, block comments, `use`, user-defined types/traits/implementations, generics, async, loops and match are outside this initial profile. Canonical regular single-link files are required; private paths, symlinks, orphan modules and incomplete input inventories refuse before mutation.

Sites use equal-width comparison, logical and `+`/`-` replacements and retain line breaks. Ancestor module rewrites remain on their isolated original lines. Pristine original-basename symlinks and exact compiler-path remaps preserve runtime source reads, source includes and source-position macros. A kill requires a complete reported harness result with a previously passing test failure. Crashes and missing results remain errors; timeouts have no invented killer. A compiler rejection is excluded only after a successful unmutated compile and a target-source Rust diagnostic. Survivors run twice more, and historical confirmation regenerates pinned sites and performs two further repetitions. Explicit changed ranges are validated; an empty range selects nothing, malformed ranges and unknown changed paths refuse. Sampling/caps never establish completeness for unfinished units.

This profile has deterministic nested-module smoke evidence for a behavior kill, an executed survivor, exact source/macro pins, invalid compilation, no coverage, freshness/refusal controls and inherited process-group timeout cleanup. It does not establish general Rust support, arbitrary native I/O containment, a native selective PR execution profile, whole-call speed improvements, or a Rust engine port. Source/full-suite and installed CLI/MCP fixture gates pass; real-repository acceptance remains unrun. The runner plans record these separate evidence levels.
