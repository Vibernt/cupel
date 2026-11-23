# Test-quality audit: Rust, workerd and one report (plan, 2026-11-23)

**Status: proposal. Nothing is built.** Owner request (2026-11-23): build the Rust
improvements and make them OS-agnostic, improve the JavaScript, TypeScript and
Python checks where needed, build a workerd collector, and give one report across
the owner's six questions. It is a signal for people and coding agents to improve
their test suites. Cupel never deletes or changes tests or code.

Evidence behind this plan: a trial of Cupel 0.1.2 (`5bfdd23`) on a private Rust and
workerd project found 10 Cupel defects (listed below), and a cargo-mutants trial on
the same project exposed planted false tests. That project's code and findings stay
outside this public repository; only the defect classes are recorded here.

## Ground rules

- **Read-only on the assessed project.** Cupel never edits, deletes, formats or
  rewrites a test or a source file. It writes only its own `.cupel/` folder (or
  `--out`), and the build output the project's own tools make (`target/`). It writes
  mutants only into scratch copies outside the project. A gate hashes every project
  file before and after each full run; any difference fails.
- **D5 and D14 stand.** Cupel never advises deleting a test. Overlap is evidence for
  a reviewer, and any removal or merge must pass `guard`.
- **L1 to L7 stand.** No model calls, a pure engine, and no new Cupel dependencies.
  External tools (cargo-mutants, Miniflare and workerd) are the user's own
  installs, found on `PATH` or named in `cupel.json`. Cupel never downloads them.
- **Branch `audit-rust-workerd`.** Each phase ends in a local commit after
  `npm run verify` on Node 26 and Node 22. Nothing is pushed, tagged or published
  without the owner's approval.
- **Each spike** is recorded in `plans/spikes/S<n>.md`, starting at S30. Each new
  input or report field gets positive and negative conformance cases.

## The report: `cupel audit`

There is one command and an MCP tool, `cupel_audit`. The output is Markdown for
people and JSON (schema in `spec/`) for agents. Each finding gives `file:line`, the
evidence and a suggested next step for a person or agent, such as "assert on the
returned value" or "make these one table test". It never edits anything. It exits 0
unless the input or environment fails: it is a signal, and `guard` stays the gate.

| Question | Signals | New in this plan | What it cannot do |
| --- | --- | --- | --- |
| 1. Wrong tests | Never passes; flaky across runs; pins source or doc text; tautologies such as `assert_eq!(x, x)` or `expect(true).toBe(true)`; asserts nothing; skipped or `#[ignore]` | Tautology and asserts-nothing checks in every language; flaky listing | Judge whether an expectation is right. The report hands those tests to a reviewer with the review pack |
| 2. False tests | Covers mutated lines but catches no fault; catches faults only by crash or panic; catches only by timeout; lines that run but where faults survive | Rust and workerd fault data; how each catch happened | Faults a tool can't generate (missing requirements) |
| 3. Tests of the same thing | Same caught-fault set and own lines within another's; same shape | Fault-set overlap | Prove redundancy (S6, S8 and S6b: wrong 23 times in 24) |
| 4. Tests to combine | Same-shape groups (A9) | A per-language form: a Rust case table, `pytest.mark.parametrize`, `test.each` | — |
| 5. Coverage | Covered, uncovered and **not measured** per file, with a reason; uncovered ranges | Every Rust crate counted; workerd coverage; "not measured" never shown as 0% | Coverage of code inside Wasm in workerd |
| 6. Faster, leaner suite | Slow tests; slow and low value (A6); flaky reruns; run order (`plan`); Rust test-binary count and link time; fault-testing cost and changed-lines mode | Rust build hints; cost estimate | Pick tests to delete. Merges reduce the test count while keeping every case |

Without fault data, sections 2 and 3 say "not measured", never "fine".

## Phases

### Phase 1: Rust coverage on any OS

| Defect | Fix |
| --- | --- |
| 1. A source file named `secrets.rs` is refused as private | Refuse secret *data* files (`.env`, keys, credential files), not Rust modules with that name |
| 3. Files linked into no test binary vanish from the denominator | List targets with `cargo metadata`; export with every instrumented test binary and workspace binary; list unseen files as "not measured" with a reason |
| 4. Tests run in the workspace root | Run each test binary from its package directory, as Cargo does |
| 5. `#[should_panic]` output aborts collection | Parse `- should panic ... ok`; report `#[ignore]` as skipped |
| 7. A CLI spawned by tests loses its coverage | Pass workspace binaries to `llvm-cov export` as objects |
| Portability | `.exe` names; ids use `/` on every OS; LLVM tools from the rustup sysroot; process-tree kill on Windows; no Homebrew paths |

**Gate:** on the real project, test statuses equal Cargo's, and every counted line
matches a plain LLVM report (the trial measured 89.48%, where Cupel said 94.48%).
The fixture suite passes on macOS here, and on Linux in Docker once that image is
approved. Windows has path and process unit tests until a real Windows run is
approved.

### Phase 2: Rust faults through cargo-mutants (ARCHITECTURE: "Import cargo-mutants")

- `cupel import cargo-mutants <mutants.out>`. Faults come from `outcomes.json`, and
  `killedBy` for each test comes from the logs, matched to collector ids through
  Cargo's `Running tests/x.rs` lines. Each catch records its kind: assertion,
  other panic, or timeout. This needs `--no-fail-fast`, so that every catching test
  is seen; incomplete logs are refused, never guessed.
- `cupel mutate` for Rust runs the installed cargo-mutants with those arguments, and
  `--in-diff` for changed lines. On Apple Silicon it runs Cargo natively under an
  Intel cargo-mutants (the trial's fix).
- **Defect 6 (timeout counted as a kill):** a timed-out fault re-runs once, alone,
  with a longer limit. A timeout never credits a test. The report lists protection
  that rests only on timeouts. The engine's existing timeout rule for `guard` is
  unchanged.
- **Defects 2, 8 and 10:** cargo-mutants becomes the default Rust backend. The
  closed-grammar mutator stays available as `--backend cupel-rust`, unchanged.
- **Spec:** an optional catch-kind field in the input format, with conformance cases.

**Gate:** on the trial's 38-fault control, caught and missed counts equal
cargo-mutants' own. Of the five planted false tests, Phase 2 flags at least four,
and Phase 3 flags the fifth (no assertion, credited only through crashes).

### Phase 3: Asserts-nothing and tautology checks, every language

Rust uses the existing lexer, JavaScript and TypeScript use Cupel's lexer, and
Python uses `ast` in the standard-library collector. A test that calls a helper in
the same file that asserts counts as asserting. Otherwise it gets "no direct
assertion", marked low confidence.

**Gate:** one fixture per runner (Cargo, node:test, Vitest, Jest, pytest), each
holding the five planted kinds: assertions removed, always true, compares a value
with itself, `assert(true)`, and no assertion. Every kind is flagged in at least one
section, and the honest tests in each fixture get zero flags.

### Phase 4: workerd coverage (spike S30 first)

**Question:** can Cupel take per-test JavaScript line coverage of Worker code that
runs in workerd, without changing the project's tests or harness?

**Method:** Cupel's node:test preload sees the workerd process that Miniflare
starts. It gives workerd a loopback-only inspector address, then takes V8 precise
coverage at each test boundary. That is the same V8 data Cupel already maps for
Node. Module names map back to repository files. **This needs owner decision 1.**
V8 doesn't see inside Wasm, so Rust compiled to Wasm is reported as "not measured:
runs as Wasm in workerd".

**Gate:** on the real project's workerd tests, statuses are unchanged. Coverage of
the Worker sources is checked against a control test that touches one known
function. Repeated runs are stable, and the tests and harness are unchanged. A
second spike then tries Vitest with `@cloudflare/vitest-pool-workers`, where tests
themselves run in workerd. If boundaries can't be reached it is per-file only, and
the report says so.

### Phase 5: workerd faults

Cupel's JavaScript mutator picks the sites. Each fault is written into a scratch
copy of the project, never the original, and only the tests covering that line
run. Tests that read source text get no catch credit (D6).

**Gate:** planted false tests in a scratch copy are flagged, and the original
tree's hashes are unchanged.

### Phase 6: the report, and JavaScript, TypeScript and Python fixes

Build `cupel audit`, the MCP tool and the docs. Run them on the real Rust and
workerd project, in throwaway copies, and on Cupel's own JavaScript and Python
suites. Change a JavaScript, TypeScript or Python pattern only where a Phase 3
fixture or one of these runs shows a miss; each change gets a conformance case.

**Gate:** `npm run verify` on Node 26 and Node 22, the Python tests, and the
before-and-after hash check on every assessed project. Then an independent review
by a fresh agent with no access to this plan's reasoning, before any claim that it
works.

## Owner decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | `scripts/check.mjs` bans every network connection, including `new WebSocket`. Per-test workerd coverage needs Cupel to talk to the workerd it started over 127.0.0.1 | Allow exactly that, as a new decision D18: one file, the loopback address only, and only to a process Cupel started. Without it, workerd code can only be reported as "not measured" |
| 2 | Download for building and testing the importer: `cargo-mutants-x86_64-apple-darwin.tar.gz` v27.1.0, 3 MB, from its GitHub release, checked against GitHub's SHA-256 | Yes. Cupel itself never downloads it |
| 3 | Local commits on branch `audit-rust-workerd` at each gate | Yes. Pushing stays a separate approval |
| Later | A Linux Docker image for the Linux gate; a Windows run, which needs a hosted GitHub Actions run and so a push | Asked with exact names and sizes when Phase 1 reaches them |

## Effort

The Rust work (Phases 1 to 3) is the 1–2 weeks estimated on 2026-11-23. The
workerd work is unknown until S30 shows whether the inspector route works; if it
fails, the plan stops there and reports why. Miniflare 5 is already installed in
local projects, so the workerd work needs no download.
