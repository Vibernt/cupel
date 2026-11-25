# Release plan: 0.5.0 (2026-11-25)

Branch `lang-speed` (36 commits over `main` 86056e2: the Rust build reuse in `plans/RUST-BUILD-REUSE.md` and the
language work in `plans/LANG-SPEED.md`). npm `@vibernt/cupel` 0.4.0 → **0.5.0**; Python `vibernt-cupel`
0.3.0 → **0.4.0** (pytest order changed). No registry upload (L6).

## What ships

| Area | Change | Default |
| --- | --- | --- |
| Rust `backend: "cupel"` | Persistent build sessions in the per-user cache (never in the project), 10 GB LRU cap, `cupel clean --rust-sessions`; unmutated passes and switches-off verdict reused when nothing changed | on (`session: false` off) |
| Rust | Stable fault numbering over the whole scope; whole-function body variants for regrouping faults | variants opt-in (`bodyVariants`) |
| Rust | Order: catch history, then targets with tests in the fault's own file | on |
| Rust | Tests-ran check; no 3x retry after a catch; `mutate-rust: timings`; verify mode `CUPEL_RUST_VERIFY_SWITCHED=1` | on / dev only |
| Rust CI | `mutate --prepare --cache-dir`, prepared slices reuse one session; `sessionEnvIgnore`; `CUPEL_*` out of the environment digest | opt-in |
| Go | Covering packages and tests only, order, stop after two (one with first-catch), guarded reuse; one switched build with per-package trust and fallback, verify mode `CUPEL_GO_VERIFY_SWITCHED=1` | on (`runners.go.mutants.schemata: false` off) |
| Ruby | Stop after two (one with first-catch), catch-history and same-name order | on |
| JS/TS, pytest | Catch-history then own-test-file order | on |

Output changes for consumers (cri-ci): Go rows gain `durationMs` (as other runners already have); new stderr
timing lines; config keys `session`, `sessionCapGB`, `bodyVariants`, `sessionEnvIgnore`,
`runners.go.mutants.schemata`; result and input shapes otherwise unchanged; `cupel-spec/1` unchanged.

## Gates before asking to merge

1. **Independent review**, cross-model, in parallel: Codex reviews the Claude-written parts (sessions, verify,
   bundles, timeouts/order) and a Claude agent reviews the Codex-written parts (batches, body variants, Go, Ruby,
   JS/Python order), both against the core promise. Fix what is real; re-review the fixes.
2. **Full suite** with every local toolchain (LLVM, cargo-mutants, Go 1.27.1, Ruby 4.0.7, Miniflare, Node 26),
   run alone. Expected failures: only the remaining known missing tools (Node 22.23.3, Vitest fixture packages,
   Homebrew Rust 1.97.1); compare by test name.
3. **Live acceptance** already recorded: Rust fixture parity (3 live tests), the private workspace (cold 29 min,
   warm 20.5 min, same-file order -54% fault test time, verify all agree), a second workspace (cargo-mutants 138 s,
   cold 42 s, warm 26 s, identical rows), Go switched vs individual identical rows.
4. **Docs**: README capabilities and version, `docs/speed.md`, `docs/rust.md`, `docs/go.md`, `docs/ruby.md`,
   `docs/best-practices.md` (sessions, bundles, `sessionEnvIgnore` in CI), version strings per HANDOFF step 1.
   Private names absent (checked on the diff).
5. **Release record** `plans/results/2026-11-25-0.5.0-release.md` (new, evidence, not verified) and the decisions
   D24–D28 in `plans/DECISIONS.md`: sessions and cache location; body variants opt-in with verify mode; CI bundles
   and the environment digest; input-only order with catch history and own-file tests across runners; Go switched
   build with per-package trust.

## Steps that need the owner's word, each time

| Step | Note |
| --- | --- |
| Push the branch and open the PR | The pre-push hook fails on the known missing tools; pushing needs `--no-verify` approval |
| Merge the PR | |
| Tag `v0.5.0` and create the GitHub release | Tarball packed twice from `git archive`, identical SHA-256, installed offline, `--version` checked |
| Tell cri-ci | Tag, checksum, output changes above, what to adapt |

## Not verified in this release

macOS only; no real Go or Ruby repository benchmark (fixtures only); the npm package smoke stops at its Rust step
without Homebrew Rust 1.97.1, so its Go and Ruby steps are unverified; Ruby result reuse stays off; one Go variant
that fails to compile sends its package to individual builds; JS/Python baselines are not persisted.
