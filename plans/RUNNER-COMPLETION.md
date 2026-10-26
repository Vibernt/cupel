# Runner capability and selective PR completion

## Frozen first-release scope (2026-10-26)

The owner selected **JS/TS/Python core full guard**, **bounded Go/Ruby/Rust
preview**, and **private experimental selective PR outside the supported first
release**. The authoritative [support matrix](../docs/support.md) defines exact
versions and evidence. This scopes the first release; it does not erase the
seven-runner work queue or promote a failed profile. [Real-repository ordinary
Jest acceptance](results/2026-10-26-jest-acceptance.md) passed on the complete
original 51-test / 4-file jest-junit lane; native real-repository acceptance is
unrun. Hosted required-check enforcement is unverified. No generic CI speedup
or publication approval is claimed. Private experimental commands and warnings
remain intact.

The active private handoff is
`.scratch/private-candidate/handoff-scope-ALquxx/handoff.json`. Its final gates
passed: **615 Node outcomes on each of Node 26 and Node 22**, **45 Python tests**
with no skips, and **35 Ruby tests / 148 assertions**. The same npm archive
passed both runtimes; the stable private installation is updated and its
predecessor retained. Version remains private `0.0.0`, with uncommitted source.

Next best action: review the intended release paths and choose the actual release
version, then verify and commit that versioned candidate before requesting
explicit publication approval. Prior counts and hashes below remain historical
evidence for their named handoffs.

Owner direction: 2026-10-25. Complete the seven runner combinations in the
support grid and report anything that cannot meet its contract. This work does
not include Java/Kotlin, .NET, PHP, a Rust engine port, publication, or telemetry.
L1–L7 remain locked.

## Owner decisions

- Selective execution may use an explicitly named, opt-in isolated profile.
  Full and selected executions use that same profile. Unsupported suites must
  refuse; isolation must never change automatically.
- A correct opt-in selective mode may ship even when slower. Report complete
  costs honestly. The earlier requirement for a speed win before promotion is
  superseded for this new scope; no safety or provenance gate is relaxed.
- The ordinary full guard remains separate. A selected-file result is not a
  whole-suite guard pass. No historical passing row is inserted as a fresh pass.
- Retain per-test coverage. Node 22 selective support must refuse rather than
  substitute file-level coverage after its inspector permission failure. The
  new Node profile is pinned to Node 26.7.0.

## Source implementation milestone (2026-10-25; support labels frozen 2026-10-26)

This table describes current source and evidence, not the previously accepted
installed artifact or a completed seven-runner release.

| Runner | Collection / mutation / ordinary guard | Selective PR |
| --- | --- | --- |
| node:test | Core full guard; existing supported capabilities; Node 22 ordinary gates pass | Node 26.7.0 v2 installed CLI/MCP accepted; complete 65-test derived Express acceptance passes with explicit source exclusions; Node 22 selective refuses |
| Jest 30.2.0 | Core full guard, narrow collection/mutation/guard; complete pinned real Jest acceptance passed (2026-10-26) | Pure-JS resolver choice resolved; ordinary six-row parity passes. S29 selective still blocked by eager watcher/cache operations and mutable-stack trust defect; no product promotion |
| Vitest 4.1.11, 5.0.1 | Core full guard; tested collection/mutation/guard support | Requires separately pinned parent/worker and transform bridges; unsupported |
| pytest, Python 3.12+ | Core full guard; existing capabilities plus fresh whole-file mutation identity checks | Blocked after approved S28 test: native callable recovery, raw directory-entry descriptors and statvfs bypass trace; no production promotion |
| Go 1.27.1, bounded pure Go | Bounded preview: AST/overlay mutation and confirmation integrated; focused, full and installed fixture gates pass; real-repository acceptance unrun | Blocked: complete native I/O enforcement unproved |
| MRI 4.0.7 / Minitest 6.0.0 | Bounded preview: in-memory mutation and confirmation integrated; focused, full and installed fixture gates pass; real-repository acceptance unrun | Blocked: complete native I/O enforcement unproved |
| Cargo / Rust 1.97.1 | Bounded preview: closed-grammar stdlib-only mutation/confirmation and CLI on aarch64 macOS pass full/installed fixture gates; real repository unrun; broader Rust unsupported | Blocked: complete native I/O enforcement unproved |

Independent Node review found two concrete request false greens: disappeared
baseline killed sites on changed critical source, and passing critical tests
becoming skipped while another killer remained. Both now have refusal paths and
actual regression tests. Edited critical tests additionally get explicitly
documented check-like retention of their own compatible line and kill evidence;
this is stronger than ordinary guard's aggregate comparison. Scoped results
remain distinct from whole-suite approval.

The complete 65-test Express source lane first refused before tests because
seven unexecuted TSX components cannot be parsed. The owner then approved
exactly those seven declared source exclusions, retaining all four test files
and all 65 tests. The new derived baseline passed two full profile runs and two
read-only reference passes. Both committed source faults failed as expected:
4 failures with 2/4 files selected, and 8 failures with 1/4 selected. Traces
contained zero access to the excluded TSX paths. Original upstream source and
opaque `.npmrc` contents were untouched. See S23 for derived provenance. This
lane had zero critical mutation sites; separate fixtures establish critical
mutation/confirmation behavior. No speed or memory gain is claimed.

The full Node 26 verify, Node 22 test suite and offline installed gates passed:
590 Node outcomes on each host, 45 Python tests with no skips, 35 Ruby tests /
148 assertions. The same npm archive passed both hosts and is installed at the
stable private path. Handoff:
`.scratch/private-candidate/handoff-grid-IGHL17/handoff.json`.

The Jest resolver choice is resolved and implemented in scratch (S29), without
changing the accepted private installation. The frozen first-release checklist
is in [FIRST-RELEASE-CHECKLIST.md](FIRST-RELEASE-CHECKLIST.md). Its next best
action is final source/artifact freeze after accepted ordinary real Jest; selective bridge hardening
is a separate feature queue. The Python metadata test stopped as instructed after
demonstrated gaps; no substitute enforcement was introduced. Vitest needs its
own worker contract after Jest. Do not repeat
seven-runner feasibility sweeps or claim a CI speed gain from fewer files alone.

## Completion means

Report collection, mutation, survivor confirmation, full guard, and selective
profile support independently, including exact verified runtime/framework and
source/transform limits. An explicit refusal is necessary safety behavior, not
completion of a missing implementation.

For each implemented capability require deterministic fixtures, negative cases,
an actual runner execution, source-text pin controls, and installed CLI/MCP
acceptance. Language promotion also requires the planned real-repository
acceptance. Missing tools, dependencies, or unsupported constructs are named
blockers; no automatic alternative runner, new dependency download, larger heap,
smaller test inventory, or disabled mutation substitutes for a failed gate.

## Expanded work queue (2026-10-25; separate from frozen first-release gates)

1. **Capability enforcement.** Stop silently omitting requested live mutation
   for standalone or mixed Go/Cargo/Minitest/custom runners. Preserve explicit
   `--no-mutation` and saved-input comparisons. The new host-side capability
   helper is the dispatch boundary; add a runner only when its implementation
   and tests pass. Do not modify the pure engine or its report schema for this.
2. **Python source integrity, S21.** Pin whole-file bytes and safe path identity
   before applying offsets, across baseline/mutant/retry/confirmation boundaries
   and inside the child loader. Confirmation requires canonical historical input
   source hashes. Keep original operator, sampling and required execution
   semantics. Verify same-ID surrounding edits, same-size/mtime writes, unsafe
   paths, source pins and actual pytest writes.
3. **Go mutation, S20.** The compiler-overlay proof passed. Implement a bounded
   pure-Go backend using the project's local toolchain, standard-library AST
   site generation, build-only overlay inputs and original runtime source files.
   Start with ordinary whole-module/package test execution, require complete
   baseline ID/status parity, and reject cgo/embedding/unverified build channels.
   Include deterministic scope/cap/sampling, invalid-build exclusion, credited
   kills, crashes/timeouts, source checks and mandatory survivor confirmation.
4. **Ruby mutation, S22.** The MRI 4.0.7/Minitest 6.0.0 in-memory loader proof
   passed. Implement lexical sites and an in-memory loader with original path
   metadata. Add canonical collector hashes, source identity checks, loaded
   proof, baseline/kill/error/timeout semantics and confirmation. Refuse
   unsupported loader behavior. Keep Rails and other Ruby implementations
   unclaimed until independently verified.
5. **Production Node selective profile.** Port the tested profile into product
   modules, preserving the frozen experimental references. Add constrained
   collection and changed-critical-line mutation/confirmation inside the same
   trusted loader/profile. An ordinary mutator layered after profile lockdown
   is incompatible and must not be used. A new baseline artifact version must
   bind this additional evidence; old S18 artifacts do not become production
   baselines. CLI/MCP must emit a separately versioned scoped PR result.
6. **Other selective profiles.** Implement and validate Vitest, Jest and pytest
   profiles separately, then native profiles only where an enforceable execution
   boundary exists. Reuse artifact/provenance/selection orchestration, not claims
   that a different runner's probes capture all dependencies. Preserve ordinary
   versus constrained full parity for eligible suites; run all original S12
   counterexamples plus new profile-specific cases.
7. **Integration and packaging.** Wire Go/Ruby only after native gates pass;
   unsupported capabilities keep explicit errors. Run full verification, Node
   22 compatibility and fresh offline package smokes before updating the private
   installation. Keep the accepted S17/S18 handoff unchanged until then.

## Selective profile acceptance

Each profile binds the base commit, trusted raw artifact hash, runner/runtime,
producer source, configuration/transforms/setup, dependency installation,
complete input/test inventory and execution policy. Trusted baseline storage
and pins stay outside the proposing agent's write scope.

Require fresh HEAD pre/post identities, completed traces, imports and file-read
dependencies including failed probes and directory reads, exact selected IDs,
critical/new/changed test handling, and explicit unsupported-channel refusals.
Non-code changes retain the explicit D16 full route; no hidden fallback executes.
Changed critical mutation uses the same profile, preserves original source reads,
requires loaded proof and confirms lost baseline kills. Do not feed a partial
HEAD into ordinary whole-suite guard.

Pass the original fault matrix plus transform/setup/shared-state/source-pin,
stale/corrupt artifact, runtime/config/dependency drift and unsupported native
channels. Include eligible clean controls and meaningful strict subsets; an
all-refusal implementation does not pass. Validate real scratch-repository
faults. Measure baseline preparation, repeated complete request and memory
separately. Latency is reported even when it is worse than full execution.

## Concrete limits

- Universal safe selection for arbitrary native I/O, external services,
  uncontrolled shared state or hostile bypass is not established by these
  probes. Opt-in isolation narrows the contract; it does not make unknown
  channels observable.
- Go's overlay primitive passes behavior/source-pin separation, but neither
  that proof nor its existing coverage collector establishes native dependency
  tracing for selective execution.
- Cargo has passing **single-file crate-root and controlled three-file graph**
  substitution primitives. Direct
  copied-source mutation caused false source/path pin failures. General module,
  build-script, procedural-macro, `include!`, feature/cfg and generated-source
  behavior remains unproven. Do not mark Rust mutation complete before those
  cases either work correctly or have explicit supported-profile refusals.
- Native selective execution needs a verified OS/toolchain execution boundary.
  A JavaScript or Python hook cannot alone prove native syscall completeness.
- Neither correct selection nor fewer selected tests guarantees a CI speedup.

The per-slice records hold implementation details, numbers and unverified
branches. This plan must not be read as a completed seven-runner release claim.
