# Source release readiness

## Frozen first-release scope (2026-10-26)

The owner selected **JS/TS/Python core full guard**, **bounded Go/Ruby/Rust
preview**, and **experimental selective PR outside the supported first
release**. The authoritative [support matrix](../docs/support.md) defines exact
versions and evidence. This scopes the first release; it does not erase the
seven-runner work queue or promote a failed profile. [Real-repository ordinary
Jest acceptance](results/2026-10-26-jest-acceptance.md) passed on the complete
original 51-test / 4-file jest-junit lane; native real-repository acceptance is
unrun. Hosted required-check enforcement is unverified. No generic CI speedup
is claimed. Experimental commands and warnings remain intact. Public GitHub
source publication for **Vibernt/cupel**, **0.1.0 / MIT**, was explicitly authorized
by the owner on **2026-10-26**. npm and PyPI remain unpublished; registry uploads,
publishing tags/releases and social posting require separate explicit approval.

The accepted **0.1.0 / MIT** artifact handoff, verified while private, is
`.scratch/private-candidate/release-0.1.0/handoff.json`. Full Node 26 verification
and Node 22 tests passed **630 Node tests each, zero skips**; Python passed
**45 tests**, and Ruby passed **35 tests / 148 assertions**, with zero skips.
The same npm archive passed installed CLI/MCP and runner positive/negative
checks on both runtimes. The stable local installation is updated with rollback
retained. See [the versioned candidate record](results/2026-10-26-private-candidate.md)
for artifact hashes and the final reviewed scope.

The reviewed release files are committed. Next best action: verify the authorized
public GitHub source and source-install workflow, then review the launch copy.
Public source approval does not authorize registry uploads, publishing tags/releases
or social posting. Earlier counts and hashes below remain historical evidence for
their named private handoffs.

## Historical planning and handoff evidence (2026-10-25)

The owner asked to continue with Astra planning and smaller models implementing,
and to run only additional spikes that change a release or adoption decision.
L1–L7 and D5 remain locked. This is a work plan, not a publication approval.

## Accepted private handoff snapshot (2026-10-25)

Accepted local artifact:
`.scratch/private-candidate/handoff-grid-IGHL17/handoff.json`.
The npm SHA-256 is
`6c302860c39d4d17f667dcff6499f45dcf9045d39af0471d569a56941b622b04`;
the same bytes passed offline package gates on Node 26.7.0 and 22.23.3. The
stable installation is updated, with its predecessor retained inside the new
handoff. Source remains uncommitted and private.

- Full Node 26 verify and Node 22 npm test: **590 Node outcomes each**.
- Python: **45 tests, no skips**. Ruby: **35 tests / 148 assertions, no skips**.
- Installed Go/Ruby/Rust behavior kills and lost-kill negatives pass; source-pin
  tests never receive kill credit. Native acceptance uses controlled fixtures,
  not general language or real repository certification.
- Installed strict/opaque Node PR CLI and MCP: prepared baseline, one-of-two-file
  clean control, lost critical kill with two confirmations, bad pin, dirty HEAD
  and Node 22 refusal pass. Scoped results never claim a whole guard pass.
- Complete derived Express lane: **65 tests / 4 files**, approved seven TSX
  analysis exclusions with zero runtime accesses. Both real faults fail with
  strict subsets (**4 failures, 2/4 files; 8 failures, 1/4**). Derived provenance
  is explicit and upstream opaque contents were never read. Critical sites: 0;
  this lane does not establish mutation behavior. See S23.
- Python metadata boundary S28 stopped with concrete unobserved native channels;
  no pytest selective code promoted. The owner chose the pure-JS Jest resolver;
  S29 ordinary parity passes, but selective execution still fails watcher/cache
  and trust-boundary gates. Vitest and native selective profiles remain unfinished.

The seven-runner grid is **not complete**. There is no public release, native
selective claim, hosted required-check acceptance, or generic CI speed claim.
The current contract and next action are in
[RUNNER-COMPLETION.md](RUNNER-COMPLETION.md).
The frozen full-guard-first release path and its exact remaining gates
are in [FIRST-RELEASE-CHECKLIST.md](FIRST-RELEASE-CHECKLIST.md).

## Archived S17/S18 private handoff

The seven-runner completion scope was subsequently reopened; see
[`RUNNER-COMPLETION.md`](RUNNER-COMPLETION.md). At the time, new source changes were not yet in
the accepted artifact below. The capability audit found that the older live
Go/Cargo/Minitest paths could omit requested mutation; do not treat their guard
as mutation-backed protection. Source now refuses unavailable live mutation;
native implementations and fresh integration/package acceptance are in progress.
The accepted full-protection scope remains the tested JS/TS/Python combinations.

The owner approved private use with full guard and Jest, keeping selective PR
execution experimental. The stable installed command is
`/Users/vid/cupel/.scratch/cupel-install/node_modules/.bin/cupel`.
Usage: [`docs/private-use.md`](../docs/private-use.md).

Accepted handoff and artifact identities are recorded in
`.scratch/private-candidate/handoff-s17s18-t7sjeq6w/handoff.json`. The npm tarball's
SHA-256 is
`a71e5aea3687e4d53d58063c9331419054df744f6b2d6a83d85f8bf83382ce75`;
the exact same bytes passed Node 26.7.0 and Node 22.23.3 artifact acceptance.
The Python handoff selects the verified Node-26-run wheel and installed Python
environment; the independently built Node-22-run wheel has a different archive
hash and is recorded separately.

Final checks after the Jest lifecycle repair, S16 engine/MCP flow changes and
S17 source-integrity/source-fact changes:

- `CUPEL_REQUIRE_JEST=1 CUPEL_REQUIRE_PACKAGE_SMOKE=1 npm run verify`: passed
  on Node 26.7.0, **455 Node outcomes, 38 Python tests, 17 Ruby tests / 75 assertions**.
- The same required flags with Node 22.23.3 `npm test`: passed, **455 outcomes**.
- Installed CLI with the installed Python wheel: **5/5 pytest tests passed**;
  MCP initialize and live report passed.
- Installed Jest 30.2.0 full Git guard, mutation enabled: **3/3 baseline mutants
  killed**, unchanged guard exit **0/pass**. Weakening the same critical test
  kept the test passing but lost all three kills; guard exit **1/fail**, with
  `critical-mutation` and coverage loss reported.
- Installed MCP report retention/replay passed after the original input was
  removed and then made invalid. Missing/malformed handles returned errors;
  historical replay did not recollect or reinterpret the changed input.
- Installed mutation source-write negative: exit **3**, explicit source-changed
  refusal before stale-offset mutation evidence could be accepted.
- `git diff --check` and repository guardrail check passed.

The live Git guard exposed an asynchronous lifecycle bug missed by saved-input
smokes: Jest config probing started eagerly even when there were zero mutation
candidates, and could outlive deletion of its temporary base tree. Configuration
is now created lazily and awaited when needed, with a real zero-mutant Git guard
regression. Earlier candidate `handoff-KhOj2a` is marked rejected and preserved.
The smoke harness now retains each run in a fresh `run-*` directory. Earlier
accepted `handoff-Q75Nm1` and `handoff-flow-KBoXoM` remain preserved and are
superseded by the current handoff. Fresh verification logs are in
`.scratch/private-candidate/verification-s17-ejt5xpcg/`.

This is a local private candidate at version `0.0.0`, with uncommitted work;
it is not a committed or public release. Hosted Action/branch protection,
external Jest repository acceptance and broader language/OS adoption remain
unverified. No additional spike is scheduled by this handoff.

## Historical performance flow follow-up

The owner subsequently asked to rethink orchestration, caching and reuse, and
whether Rust could improve Cupel. [S16](spikes/S16.md) records the measured work;
[`PERFORMANCE-FLOW.md`](PERFORMANCE-FLOW.md) separates implemented reuse from
future source-analysis and persistent-cache designs.

Current follow-up state: [S17](spikes/S17.md) source-fact reuse and the newly
required source-integrity checks passed three-way parity, full runtime gates
and installed acceptance. The current handoff contains S17 as a correctness
improvement; its measured workloads do not show a general latency win.
[S18](spikes/S18.md) saved-baseline incremental selection passed its safety
matrices and whole-call measurement but remains experimental. Additional source-backed reuse
opportunities and their invalidation/test decisions are recorded in the
[reuse audit](PERFORMANCE-FLOW.md#additional-reuse-audit-2026-10-25); they are not
advertised as implemented gains. Rust remains deferred by owner direction.

- Pure engine: all **120 complete reports/exits** matched the pre-edit oracle.
  Guard/validate skip unused advice; grouping and duplicate/file indexing avoid
  repeated scans. The actual 65-row full CLI guard improved by about 4 ms;
  a labeled synthetic 10,000-unit engine report improved **31.1%**, 778→536 ms.
  Small actual reports showed no meaningful gain; RSS did not improve.
- MCP: explicit `retain`/`snapshotId` report reuse is implemented, bounded to
  8 reports / 32 MiB. Page replay executes **zero CLI/collector/mutation calls**
  in focused tests and is explicitly historical. Ordinary calls remain fresh;
  guard cannot consume a report snapshot. Seventeen focused tests passed on
  both runtimes, including corruption/eviction/root/process/immutability checks.
- Selective prototype: one coherent verified request reduced old whole-call
  medians **416→318 ms** and **331→247 ms**, improving 23.6%/25.4% with 5/5 wins
  in each comparison. It still lost every pair against guarded full, at
  **329/245 ms versus 132 ms** in separate comparison sets. It remains
  experimental; no selective CLI/MCP execution tool was installed at that milestone.

The deterministic portable engine, required runs, per-test processes and all
refusal/privacy checks remain. No Rust dependency or native rewrite was added.
Remaining optimization ideas are measured candidates, not promises of speed.

- S17: exact mutation/confirmation and execution-count parity held on Node
  22/26. Two-job diagnostics saved 1–4 source reads, but whole-call reuse did
  not improve the existing Node/Jest fixtures. Keep the fresh source checks;
  do not advertise a broad speedup. [Detailed result](spikes/s17/RESULTS.md).
- S18: all **60/60** original matrix cases passed with the baseline path
  unavailable; focused tests passed **8/8 per host**. Saved baseline reuse
  reduced real selection medians **338.67→287.07 ms** and **250.45→208.68 ms**
  with 5/5 wins each. In separate full comparisons it still lost every pair:
  **288.99/208.95 ms versus 136/137 ms**. Accounted preparation was 998.10 ms,
  excluding the unavailable original collector-generation cost. Artifact
  read/hash/parse was about 0.55 ms; skipping that work alone cannot bridge
  the gap. Throughput and total memory were not measured.
  [Detailed result](spikes/s18/measure/RESULTS.md).

No further release-blocking research spike is needed for this private full-guard
candidate. The owner subsequently authorized the conditional repeated mutation
coverage parsing profile, [S19](spikes/S19.md). On the complete default-jobs
workloads, repeated parsing cost about 0.02–0.19 ms and less than 0.04% of request
wall; entire selection was below 1 ms. The 10 ms / 5% trigger failed, so no
coverage cache or product change was made. Historical input-only replay remains
separate from whole-call evidence. The accepted installation above is unchanged.
Selective execution is not promoted, and Rust remains deferred.

## Scope and order

1. **Evidence integrity (P0).** Reconcile baseline/report runner scope and test
   inventories. New measurements record source and Cupel revisions, config,
   runtimes and inventory identity. Historical results without those bindings
   remain unverified. Preserve failures and raw cold/warm timings; suppress
   unsupported overhead claims. Regenerate `bench/BENCHMARK.md` without launching
   another ten-repository benchmark marathon.
2. **Jest and S12: selective PR safety (P1).** The owner explicitly requires Jest
   before release (2026-10-25). Implement and validate Jest first; the launch and
   safety matrix covers node:test, Vitest, Jest and pytest. Compare deliberately
   broken changes against a full-suite oracle.
   Require an exact baseline identity; select changed-source-file coverage,
   setup coverage, critical tests and new/changed tests. Non-code changes have
   the explicit full-suite route already required by D16. Missing/corrupt/stale
   evidence or an unsupported selection is an error, never an automatic alternate
   route. Do not claim skipped tests passed. Any false green blocks production PR
   mode. Record measured wall time separately from estimated duration sums.
3. **S13: agent cleanup acceptance (P2).** Review at most three candidates in a
   scratch copy, inspect their assertions, and make at most one justified
   consolidation/rewrite. Full guard is authoritative. Include intentionally
   damaged controls and retain all tests if there is no defensible change.
   No approval of a critical removal may be fabricated.
4. **S14: installed artifacts and extension use (P3).** Exercise an actual npm
   tarball and, when offline build tools exist, a Python wheel in clean scratch
   environments. Validate CLI, MCP, schemas and guard rejection. Complete public
   extension instructions, then have a fresh agent implement a tiny adapter using
   only those documents. Missing build tooling is a named blocker; do not download
   it or replace the wheel with a source-tree smoke test.
5. **M5 enforcement and conclusion.** Implement/test the Action wrapper locally,
   including trusted guard configuration, exit codes and job summaries. Keep live
   GitHub enforcement/branch protection acceptance explicitly unverified until
   an authorized private test-repository run. Run `npm run verify` and Node 22
   tests before any commit to main. Summarize remaining release blockers.

## Pass/fail gates

- No advertised ratio from mismatched runners, unreconciled test IDs or unknown
  provenance. A documented failed candidate is an acceptable audit outcome.
- S12: zero false greens in evaluable injected faults, explicit rejection of
  invalid baselines/unsupported selections, and all new/changed tests executed.
  Small fixtures establish regression coverage; real scratch cases establish the
  limits of practical acceptance. These are separate evidence levels.
- S13: source-grounded review and a passing full guard on an accepted edit,
  plus failing negative controls. Retaining every candidate demonstrates review
  restraint, not cleanup efficacy.
- S14: installed artifacts work independently of repository layout; adapter
  conformance succeeds from public documentation. An unavailable environment is
  not a pass.
- No publication, public repository conversion, publishing tags/releases,
  telemetry, connector work or model calls inside Cupel.

## Bounded repairs already started

- Ruby: generated ActiveSupport `test "…" do` declarations must retain stable
  identity; malformed/ambiguous declarations still fail explicitly.
- Rust: diagnose the observed collector heap exhaustion and bound intermediate
  coverage retention; no heap-size increase or reduced runner scope as a remedy.
- Zeron: explain the missing offline toolchain components before rerunning it.
  Post-launch language acceptance does not block declaring the measured limits of
  the JS/TS/Python candidate.

## Deferred work

No further automatic-retirement/subsumption research, full S8 A/B, new language
collectors, Go test-harness rewrite, broad benchmark rerun, UI or integrations.
Jest was absent at the start of this pass and is now required by the owner before
release. Do not claim it is supported or mark M6 complete until its acceptance
passes. Existing collector bugs remain visible even if their languages are
outside the launch scope.

## Execution record

Astra produced the scope and gates; smaller model agents implement bounded,
disjoint slices. Individual spike results hold methods, raw numbers, verdicts and
unverified branches. This document is updated as those slices finish.

- P0: benchmark comparison audit implemented and tested; historical ratios are
  invalid or unverified. New Docker capture has no live acceptance run yet.
- Collector repairs: Ruby's real failing file passed 25/25; a bounded real Rust
  slice passed without heap exhaustion. Full mixed-language reruns remain open.
- S12: **failed** on all four launch runners. Runtime coverage misses source-text
  read dependencies; full oracles fail while selected tests pass. No production
  selective PR mode is being shipped from this spike.
- S13: three real candidates reviewed and retained for distinct assertions.
  No edit or cleanup-efficacy result is claimed.
- S14 artifact slice: actual npm and Python packages install and smoke offline;
  legal assets and Python minimum-version metadata repaired. Documentation-only
  consumer and final runtime gates are recorded separately.
- M5: local real-CLI guard tests pass, including attempted head-policy bypass.
  They exposed and now cover the pre-existing `guard --base` mutation crash.
  Hosted check execution/branch protection remain unverified.
- Jest: required by owner; 15 actual-runtime cases passed on Node 26/22,
  including mutation and recheck behavior. Installed CLI/MCP Jest collection
  passed. An external Jest repository remains unverified.

## Subsequent owner direction: selective PR mode

After seeing S12, the owner asked whether selective PR mode is possible and
explicitly requested implementing and validating it if possible. That authorizes
a bounded S12b dependency-evidence design and validation round; it does not
authorize silently routing incomplete evidence to a full run. Astra plans the
contract and smaller models implement the bounded slices. S12's four failures
remain mandatory controls. Production PR mode stays blocked until the new
safety and actual-use gates pass.

Checkpoint before this new round: `CUPEL_REQUIRE_JEST=1
CUPEL_REQUIRE_PACKAGE_SMOKE=1 npm run verify` passed on Node 26.7.0: 432 Node
outcomes, 38 Python tests, 17 Ruby tests / 75 assertions. The previous 449 count
incorrectly included the Ruby reporter's 17 dots as Node outcomes. The full `npm test` gate
also passed on Node 22.23.3 with the required Jest and artifact flags. This
checkpoint does not cover the forthcoming S12b code.

Both release commands were repeated successfully during S12b. Experimental
S12b modules have separate targeted tests and are not part of the normal
`npm test` file glob.

The owner approved **Node-only selective validation first**, then an opt-in
opaque exclusion of the pinned Express lane's root `.npmrc`. Its contents are
never read or hashed; all test access is forbidden, including in the full
reference run. Other private paths retain strict refusal.

Final runtime identity:
`sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b`.
Profile controls passed **70/70**, evidence/selection controls **23/23**, under
both exact runtime harnesses. All four original matrices (Node 22/26 ×
strict/opaque) passed. Each had 15 scenarios, 10 injected faults, 8 selections,
1 explicit D16 full run, 6 refusals, 7 changed-code strict subsets and zero
mismatches/false greens. The source-text pin was caught using 4/8 files.

The unchanged Express lane passed 65/65 on Node 26.7.0 and matched collector
and constrained IDs/statuses. Both source faults were caught with strict
subsets: 2/4 files caught all 4 failures; 1/4 caught all 8. Full reference
privacy proofs were complete with no denial/error. Five alternating pairs per
fault nevertheless measured entire selection API medians **414 vs 133 ms** and
**327 vs 131 ms**, compared with privacy-guarded full. Selection was slower in
all ten pairs. Baseline profiling cost 669 ms separately.

**S12b is concluded without production promotion.** Its tested Node mechanism
works, but the real latency gate fails. Astra confirmed stopping this bounded
performance pass. Existing full guard and the tested Jest capability remain
available for the private candidate. Hosted Action enforcement, external Jest
repository acceptance and public release approval remain separate/unverified.
See [S12b](spikes/S12b.md) and its real-lane report for raw-evidence locations.
