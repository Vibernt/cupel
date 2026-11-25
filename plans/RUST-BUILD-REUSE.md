# Plan: Rust build reuse (2026-11-25)

Owner request: review a proposal for "compile once, run many faults" (function-body
variants, persistent build sessions, direct binary execution, CI bundles, ideas from
Blaze) against the code at `86056e2` and the 0.4.0 measurements, then plan and build it
with parallel agents. Owner decisions (2026-11-25): success is judged on **all three**
workload types (the private Rust workspace measured for 0.4.0, a build-heavy Rust
workspace, and general Rust users); persistent sessions capped at **10 GB** with
eviction; **data-first** order; Codex CLI agents allowed alongside Claude agents.

## Review findings

The proposal's statements about the code are accurate: schemata switch faults with
`CUPEL_FAULT`; 29 regrouping operator faults get their own build; the scratch
workspace and `target/` are deleted after each campaign; `runTarget` calls
`cargo test` per target and fault; switch numbers come from `plan.run` after slicing,
so slices build different binaries.

Where the data disagrees with its priorities, on the 0.4.0 first-catch run (27 min,
90 faults):

| Phase | Time | Share |
| --- | --- | --- |
| Setup: cold build, baseline pass, switched build, switches-off pass | ~500 s | 31% |
| Unnoticed faults (every covering test must run) | 294 s | 18% |
| Timed-out faults (6) | 242 s | 15% |
| Caught faults (71) | 559 s | 35% |
| Per-fault builds (29 regrouping + 5 partial) | within ~215 s | ~13% |

The median fault took 0.8 s; `cargo test` overhead per call was ~40–80 ms. So on that
workload persistent sessions and cached baselines matter most, function-body variants
save ~2 minutes, and direct binary execution little. Build-heavy workspaces can differ,
which is why they are measured separately.

Found during review and fixed first: the runner did not check that the named tests
ran, so a libtest filter matching nothing could read as "survived".

## Phases

| Phase | Work | Gate | Agent |
| --- | --- | --- | --- |
| 0 | Tests-ran check; per-phase timings (`mutate-rust: timings`, `CUPEL_RUST_TIMINGS`) | Fixture parity; timing report on both workloads | Sonnet (done: `rust-timing`) |
| 1 | Persistent build sessions: per project+toolchain+flags, changed-file sync, lock, crash re-sync, 10 GB LRU cap, `cupel clean --rust-sessions`; reuse baseline and switches-off verdicts per executable hash | Warm repeat run far below cold setup; identical rows; simulated crash restored | Sonnet (`rust-sessions`) |
| 2 | Stable fault numbering over the whole listing and deterministic bounded batches | Same switched build for every slice of a plan | Codex (`rust-batches`) |
| 3 | Catch-history order: last run's catching target first | Same statuses; faster first catches | Haiku (`rust-order`) |
| 4 | Timeout tuning (per-test limits, one retry) | No new timeouts; less time on timed-out faults | after 1–3 |
| 5 | Function-body variants for regrouping faults (exact text mutation per variant, chosen at function entry, one line, bounded) | Each switched variant agrees with its individual build: status, catchers, catch kinds | Codex (`rust-body`) |
| 6 | CI bundles: one preparation, slices run the same executables (identical OS, toolchain, absolute paths) | Slices from one bundle equal a whole run | after 1–2 |
| 7 | Direct binary execution | Only if timings show cargo overhead matters | deferred |

Integration: each phase on its own branch and worktree with file ownership; the lead
reviews, merges into `rust-reuse`, runs fixture parity (cargo-mutants vs Cupel one-build
vs switched vs body variants) and the timing runs; one heavy run at a time on this
machine. A cross-model review (Codex reviews Claude's diffs and the reverse) precedes
the release.

## Risks

- Persistent workspaces: disk (capped, evicted), crash safety (re-sync before use,
  never write the project), concurrent runs (lock).
- Cached baselines vs timing-sensitive tests: reuse only per identical executable hash
  and named tests; per-target trust stays.
- Function-body variants: local items, macros, `line!()`, line numbers (variants on
  one line), compile time and binary size for generics (bounded per function and in
  bytes); refuse when unsure, fall back to an individual build.
- CI bundles: binaries embed compile-time paths (`env!("CARGO_MANIFEST_DIR")`), so a
  bundle needs the identical layout on every worker.
- Blaze is a design reference only; copied code would need its MIT notices.
- Validation throughput: one heavy workload run at a time on this machine.

## Status (2026-11-25, `rust-integrate`)

- Phase 2 (stable numbering): integrated in the runner. Numbers come from `stableSelectors` over the whole
  listing of every file with a fault to run; every acceptable listed fault is rendered, so slices and reuse
  produce byte-identical switched sources.
- Phase 5 (body variants): integrated. Regrouping `BinaryOperator` faults are answered in the switched build;
  operator switches on the same line are shifted by the inserted text (`bodyVariants` returns `insertions`);
  faults beyond 8 per function get individual builds. Acceptance bar: `CUPEL_RUST_VERIFY_SWITCHED=1` reruns each
  switched answer on its own build and refuses on any difference in status, catchers or kinds.
- Switches-off verdict is reused across runs, keyed on a digest of the session, selector table, rewritten sources
  and the unmodified build.
