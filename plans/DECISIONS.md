# Decisions

## Locked (owner, 2026-10-21)

| Id | Decision |
|---|---|
| L1 | Name: **Cupel**. npm `@vibernt/cupel` (command `cupel`), PyPI `vibernt-cupel`, GitHub `Vibernt/cupel` |
| L2 | Open source. CLI, local MCP server and GitHub Action only. No UI, no hosted service, no analytics, no telemetry |
| L3 | Built fully independent first; Vibernt Assay and CodeCrystal integrate later (opt-in connectors) |
| L4 | Deterministic: no model calls inside Cupel |
| L5 | The guard runs in CI, outside the agent's write scope; people approve retirements and anything critical |
| L6 | Repository starts **private** and becomes public only at launch, on the owner's approval. Publishing to npm or PyPI also needs the owner's approval |
| L7 | Do not use the Fable model for this work unless the owner asks |

## Decided

| Id | Decision | Date |
|---|---|---|
| D2 | Licence: **MIT** for first-party Cupel code. `LICENSE` is canonical; `NOTICE` records attribution and separate third-party provenance. Supersedes the original Apache-2.0 choice; see the owner decision below. | 2026-10-26 (owner) |
| D7 | Coverage granularity: **per-test is the v1 default for node:test.** One ordinary `node --test` run with an `--import` preload takes in-process V8 precise coverage (`node:inspector` `Session.connect()`, no port) between tests: about 1.4× a plain run on Assay ([S2](spikes/S2.md)). Per-file is the fallback, when the hook cannot attach, and the report's summary level. Per-test processes (`--test-name-pattern`, 4–11×) only re-check retire candidates and tests that spawn node, which removes the in-process method's first-touch bias and child-process blind spot. The data model keys coverage by test id with `granularity: "file" \| "test"`. The default scope is the whole repository minus `tests/`, `node_modules` and dot-directories ([S1](spikes/S1.md)). Verified on Node 22.23.3: hooks, counter reset and per-test attribution behave as on 26. Line sets differ slightly between Node versions, so `guard` must collect base and head on the same runtime | 2026-10-21, from S1 and S2 |
| D6 | JS parsing for mutation: **a zero-dependency textual lexer** for v1, with a standard-library validity filter (`vm.SourceTextModule`, falling back to `node --check`). On Assay it matches acorn on all 2 M tokens and on 99.85% of mutation sites, with no false sites and 0 invalid mutants ([S3](spikes/S3.md)). acorn 8.19.0 (MIT, one 235 KB file, no dependencies) is the fallback if ternary-condition mutants or JSX are needed. The TypeScript compiler API is rejected: about 56 MB, and its JS API is unstable. TypeScript sources are mutated after `module.stripTypeScriptTypes`, which keeps offsets. Mutants are served in memory through a module load hook, never written to disk, so source-text pins earn no kills. A kill counts only when a test reports a failure; a crash is an environment error **JSX and TSX** (2026-10-22): when a project has `typescript` installed, Cupel uses that project's own TypeScript scanner (`ts.createScanner`, which keeps offsets) for line classification and mutation sites in `.tsx`/`.jsx`; otherwise those files are skipped with a note. Cupel itself still has no dependency | 2026-10-21, from S3; JSX 2026-10-22 |
| D10 | **The engine's input format is public**: a versioned JSON Schema in the spec, beside the report schema. `cupel import` reads it and supported tool formats. Every collector, native or third-party, emits it; existing mutation and coverage tools are imported rather than re-implemented. This is how Cupel reaches languages beyond JS and Python | 2026-10-21 (owner) |
| D11 | **Languages:** launch with JavaScript, TypeScript and Python. Then add Java and Kotlin, Go, .NET, Rust, Ruby and PHP, in that order, shipping each as it passes its conformance cases and a real-repository run | 2026-10-21 (owner) |
| D12 | **Frameworks:** coverage and mutation are built once per language. Per-file coverage works for every framework with no framework code. Per-test coverage uses a thin framework adapter that implements a contract in the spec (list, select, boundaries, tags) | 2026-10-21 |
| D13 | **Extensibility is first-class.** People extend Cupel through config (tier rules, brittleness patterns), the public input format, external collector commands and framework adapters, all **outside Cupel's process**: no third-party code is loaded into Cupel. Extensions prove themselves with the adapter conformance kit; `docs/extending/` documents every extension point, and one adapter is built from the docs alone before launch | 2026-10-21 (owner) |
| D4 | **Critical tier words** (owner approved the S6 revision): auth, permissions, tenancy, tokens, secrets, egress, billing, quotas, migrations, backups, deletion, public API, plus credential, crypto, leak, unsafe, sign-in, login, security, isolation, sandbox, privacy, integrity, redact, inject, traversal, hardening, admission, budget; title tags such as negative, tamper, forged, refuse, permission, token, secret. "Covers any critical line" guards against retirement; names, tags and unique critical lines decide the tier ([S6](spikes/S6.md)) | 2026-10-21 (owner) |
| D5 | **No retire advice in v1** (owner, after S6b). Cupel never advises `retire`. In three measurements, deterministic signals could not tell a redundant test from one with unique assertions: S6 (coverage only, right 1 in 20), S8 (coverage "adds nothing", wrong 23 of 24) and S6b (mutation-backed, 0–4 % precision across two independent judges). Units that would have qualified get the review hint `no-unique-evidence`, never advice to remove. No further research on retire is planned | 2026-10-22 (owner) |
| D14 | **`check` never says a test adds nothing.** A test with no unique coverage and no unique kill gets the verdict `no-unique-evidence`, which is informational: `check` exits 1 only for `weakens`, `fails` or `not-run` | 2026-10-22 (owner, with D5) |
| D15 | **Cleanup review pack for agents** (owner, after S11 and the benchmark speed discussion). A new MCP tool and CLI command hand an LLM agent the evidence it needs to decide on deleting or merging tests: per candidate, its unique lines and kills, which other tests cover the same lines and kill the same mutants, assertion fingerprints, its same-shape group, tier, brittleness and pseudo-tested functions. It never advises removal (D5 stands): the pack states that no unique evidence is not proof of redundancy, and the agent's change must pass `guard` before it is committed | 2026-10-24 (owner) |
| D16 | **PR mode is the next milestone** (owner, open decision 1). Collect only the tests affected by a change (coverage map from main's saved report, plus new and changed test files, with a full run when non-code inputs change), compare against main's saved report, and mutate only changed critical lines. It starts with a safety spike that replays deliberately broken changes to measure missed failures | 2026-10-24 (owner) |
| D17 | **Collect once in CI** (owner, via the Assay integration, 2026-10-28). `cupel collect-node` runs node:test once with per-test coverage as the CI test step (real exit: 0 passed, 1 tests failed, 2 usage, 3 incomplete collection), with deterministic `--shard I/N` and strict `merge-inputs`, plus `cupel mutate` on a precollected input (`--base-input` keeps K7). Inputs record `collection` (runs, config digest, commit, shard or subset); guard warns `single-run` and refuses subsets (`subset-input`), which `check` accepts. Cupel runs `node --test` itself rather than wrapping the project's command through NODE_OPTIONS: reporters from NODE_OPTIONS are prepended to the CLI's, so a project `--test-reporter` without a destination fails on Node 22.23.3 and 26.7.0, and Cupel could not tell which files ran. **Mutation is not sharded**: the mutant set is chosen dynamically (invalid draws are replaced in seeded order until `maxMutants` valid mutants ran) and `maxSeconds` is wall-clock, so per-shard budgets would change what `sampled` and G6's "present at head" mean. Assay copy, 4,142 tests, 12-core Mac: plain `node --test` 43.6 s, collect-node one run 48.1 s, two runs 101.0 s; with two workers 120.5 s plain and 161.7 s collect-node | 2026-10-28 |
| D8 | **Jest is required before release**, alongside node:test, Vitest and pytest. A working collector, real-runtime tests, mutation/guard integration and the PR safety cases must be verified before claiming Jest support. Other languages retain their separate real-repository acceptance gates | 2026-10-25 (owner) |

## Historical implementation progression (through 2026-10-25)

D16 implementation was **blocked by [S12](spikes/S12.md)**: its experimental
selection produced a false green in each of node:test, Vitest, Jest and pytest.
No selective PR execution command shipped from S12. Concluding this candidate without that
feature was presented as an owner scope decision. The owner instead requested
implementing and validating safe selective PR mode if possible, authorizing a
bounded dependency-evidence follow-up. Public publication approval stays separate.
The owner subsequently approved Node-only validation first. S12b's strict Node
profile passed its safety matrix; practical acceptance is still required. The
owner also explicitly approved an opt-in opaque exclusion of the real Express
lane's exact root `.npmrc`: never read or hash its contents, forbid test access,
and preserve strict refusal for other private paths. The bounded policy and new
validation gates are recorded in [S12b](spikes/S12b.md).
The final S12b matrices and real faults pass for the tested Node profile, but
the entire selection API is slower in all ten real timing pairs. The bounded
spike is concluded without production CLI/MCP promotion; full guard remains
authoritative. No additional performance research is part of this pass.
The owner then reopened performance work, asking to rethink flow, orchestration,
caching and reuse, and whether Rust could help. This authorizes the separate
[S16](spikes/S16.md) measured pass and [performance flow](PERFORMANCE-FLOW.md)
design. S12b's outcome and the accepted private artifact remain unchanged until
a new implementation passes equivalence, safety and whole-call timing gates.
S16's request reuse improved old selective latency 23.6%/25.4% but still lost
every paired full-run comparison, so selective execution remains experimental.
Its pure-engine flow improvements and explicit historical MCP report snapshots
passed both required Node gates and installed acceptance and are in the refreshed
private artifact. General persistent caches, parse-worker pooling and Rust
kernels remain planned, not implemented.

Owner scope expansion, 2026-10-25: complete capabilities and selective PR support
for the seven grid runners: node:test, Vitest, Jest, pytest, Go testing,
Rust/Cargo and Ruby/Minitest, and report infeasible or blocked cases explicitly.
The owner approved named **opt-in isolated profiles**, with unsupported suites
refused, and approved correct opt-in selection **even when slower**, with honest
complete-cost reporting. This supersedes the earlier speed-win promotion gate
for the expanded scope, not safety, source integrity, provenance or required
execution. Ordinary full guard remains separate. Rust language support is in
scope; a Rust engine port remains deferred. Implementation and per-runner gates
are in [RUNNER-COMPLETION.md](RUNNER-COMPLETION.md). Nothing here authorizes
publishing or automatic fallback.

## Owner release-scope direction (2026-10-26)

Owner licence and candidate-version decision, 2026-10-26: **MIT** supersedes D2's
earlier Apache-2.0 choice for Cupel's first-party code. `LICENSE` is the canonical
MIT text with Copyright (c) 2026 Vibernt; npm and Python carry identical copies.
`NOTICE` remains informational Vibernt attribution. This change does not relicense
third-party components or change their attribution and licence obligations.
The first release candidate is **0.1.0** in both `@vibernt/cupel` and
`vibernt-cupel`. It remains private: npm retains `"private": true` and Python
retains `Private :: Do Not Upload`. This selects the candidate's licence and
version only; it does not authorize publication, releases or publishing tags,
and does not reopen L1–L7.

The first-release contract is **JS/TS/Python core full guard**, with **bounded
Go/Ruby/Rust preview**. **Selective PR execution is outside the supported first
release**. The existing private experimental Node 26.7.0 CLI/MCP commands remain
available with their warnings and strict refusals. This direction scopes the
first release and does not alter L1–L7, D5, historical spike outcomes or the
separate seven-runner completion queue.

The authoritative [support matrix](../docs/support.md) records exact runtime,
framework, source and transform limits. Narrow Jest 30.2.0 passed its
[real-repository ordinary guard acceptance gate](results/2026-10-26-jest-acceptance.md)
on the complete original 51-test / 4-file pinned jest-junit lane. This does not
broaden the native ESM test or arbitrary-transform boundary. Go 1.27.1, MRI 4.0.7 /
Minitest 6.0.0 and closed-grammar macOS Rust/Cargo 1.97.1 retain installed fixture
evidence only; native real-repository acceptance remains unrun. No generic CI
speedup, hosted required-check enforcement or public release is claimed. npm
and Python remain private. No alternate runner, reduced inventory, suppressed
warning or automatic fallback is authorized.

Next best action: freeze source/artifacts, consolidate the incoming private
handoff, and rerun the exact required gates in
[FIRST-RELEASE-CHECKLIST.md](FIRST-RELEASE-CHECKLIST.md). Publication approval is
still a later explicit owner decision.

## Dependencies

The owner retained per-test coverage and required narrowing or blocking Node 22
selective execution after its inspector permission failure. Production v2 is
therefore pinned to Node 26.7.0; ordinary Node 22 collection/guard remain in
scope. Edited critical tests in the opt-in profile additionally retain their
own compatible line and kill evidence (check-like comparison), explicitly
stronger than ordinary full guard's aggregate comparison. This never changes
the result into a whole-suite guard pass.

The owner authorized a separate Python metadata-interception boundary test,
with the explicit instruction to stop if incomplete. That does not authorize
dropping missed channels, weakening audit enforcement or claiming pytest
selective support from metadata unit tests alone.

There are none yet. Each dependency must be pinned to an exact version and justified here; `scripts/check.mjs` enforces both.

Jest validation: the test-only fixture in `spec/conformance/adapters/jest/`
pins `jest` **30.2.0** as its project-owned runner and `typescript` **5.9.3**
to produce the transformed-source fixture and its inline source map. They are
installed only in that fixture or ignored scratch projects, never as Cupel
package dependencies. The verified gate targets that exact Jest version,
jest-circus and the Node environment; other environments/versions are not
claimed without actual-runtime verification.

Installed-artifact validation uses an isolated scratch tool environment with
`setuptools` **80.9.0** (the existing build backend), `wheel` **0.48.0**, `pytest`
**9.1.1** and `pluggy` **1.6.0**. These are test/build tools only; neither package
gains a production dependency. The actual wheel build and clean installation run
offline after this environment is explicitly prepared. Python package metadata
now requires **3.12+**, matching the collector's existing `sys.monitoring` check.

## Open

| Id | Question | Recommendation |
|---|---|---|
| D3 | Coverage target wording | 100% line and branch on critical modules, a ratchet elsewhere |
| D9 | Report schema versioning | `cupel-spec/1`, semver-style, breaking changes bump the major |

## Owner public GitHub launch authorization (2026-10-26)

The owner explicitly approved making **Vibernt/cupel public on GitHub** with
first-party **MIT** licensing at version **0.1.0**, and requested a developer
README plus LinkedIn launch copy. This fulfills the repository-launch condition
in L6; L1–L7 remain locked. It supersedes earlier pending-approval statements for
GitHub source visibility only. Historical private handoffs, hashes and acceptance
records retain their original status and provenance.

**npm and PyPI remain unpublished.** npm packages keep `"private": true` and the
Python package keeps `Private :: Do Not Upload`. Registry uploads, publishing
tags/releases and posting the launch copy require separate explicit approval;
preparing copy does not authorize posting. The support contract remains
JS/TS/Python ordinary full guard with bounded Go/Ruby/Rust previews. Selective
PR commands remain experimental and outside the supported first release; public
source visibility does not promote their capabilities or weaken any refusal.

## Owner v0.1.1 release approval (2026-10-28)

The owner approved, in chat, bumping the npm package to **0.1.1** (collect-once,
D17) and committing, tagging and pushing **v0.1.1** on the public repository. The
Python collector package is unchanged and stays at 0.1.0. npm and PyPI publishing
remain unapproved; packages keep `"private": true` and `Private :: Do Not Upload`.
