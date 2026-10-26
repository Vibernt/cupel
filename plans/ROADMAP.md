# Roadmap

## Frozen first-release scope (2026-10-26)

The owner selected **JS/TS/Python core full guard**, **bounded Go/Ruby/Rust
preview**, and **experimental selective PR outside the supported first release**.
The authoritative [support matrix](../docs/support.md) defines exact versions
and evidence. Native real-repository acceptance and hosted required-check
enforcement remain unverified; no generic CI speedup is claimed.

The current source version is **0.1.0 / MIT**. The owner authorized public GitHub
source publication for **Vibernt/cupel** on **2026-10-26**, satisfying L6's source
visibility condition. npm and PyPI remain unpublished; their private publishing
guards stay enabled. Registry uploads, publishing tags/releases and social
posting still require separate explicit owner approval.

The [versioned candidate record](results/2026-10-26-private-candidate.md) preserves
its private artifact acceptance: **630 Node tests on each of Node 26 and Node 22**,
**45 Python tests**, **35 Ruby tests / 148 assertions**, all without skips, plus
fresh real-Jest CLI/MCP positive and negative controls. Its local handoff is
`.scratch/private-candidate/release-0.1.0/handoff.json`. The stable local install
and its rollback are recorded there. Historical 0.0.0 handoffs are preserved.

Next best action: verify the authorized public GitHub source and documented
source-install workflow, then review the launch copy. Source visibility does not
promote experimental support or approve package uploads.

## Historical acceptance snapshot (2026-10-25)

The table below retains the milestone definitions. Implemented code and completed
acceptance are distinct:

- M0–M3: engine, CLI, schemas and 78 conformance cases exist; current full gates
  are recorded in `RELEASE-READINESS.md` after integration.
- M4: MCP and D15 review pack implemented; S13 reviewed three real candidates and
  retained them. No review → edit → guard cleanup saving is claimed.
- M5: Action wrapper and local real-CLI negative tests implemented. Hosted
  enforcement and required-check configuration are unverified.
- M6: node:test, Vitest and pytest implemented; Jest is required before release
  by D8 and its tested capability is recorded in S15. Do not infer support for
  untested Jest versions/environments.
- M6b: Go/Rust/Ruby provisional; known benchmark and acceptance gaps remain.
- M6c: extension references and examples implemented; fresh-agent consumer
  evidence and its limitations are recorded with S14.
- D16: coverage-only selective PR mode failed S12. The owner-approved Node-only
  S12b profile passes its frozen safety matrix with changed-code strict subsets;
  the owner-approved opaque `.npmrc` profile also catches both real Express
  faults with strict subsets. Complete selection is slower in all ten timing
  pairs, so S12b is concluded without production promotion. Existing full guard
  and plan ordering remain available.
- Performance follow-up: S16 reduced selective request overhead 24–25% but still
  lost to guarded full; no selective execution API shipped from that milestone. Pure engine flow
  improvements and explicit MCP historical report snapshots are tested and
  installed in the refreshed private handoff. S17's source-integrity checks and
  request-local source facts passed installed acceptance, without a broad speed
  claim. S18's saved baseline improved selection another 15–17% but still lost
  to guarded full execution. S19's coverage-parsing profile failed its meaningful
  saving trigger; no coverage cache was implemented. Persistent analysis caches
  and parse-worker reuse remain candidates; Rust is deferred unless measured
  value justifies it. No further performance research is scheduled from S19.
- M7/M8: no public launch, package publication or integration is authorized.

## Milestone definitions

| Milestone | Contents | Done when |
|---|---|---|
| **M0 Kickoff** | Private repo `Vibernt/cupel`, licence file per D2 (now MIT), README stub, AGENTS.md and CLAUDE.md, local checks run by a pre-push hook (no hosted CI for the repo itself; owner, 2026-10-21), plans moved in | Repo exists, `npm run verify` green, plans committed |
| **M1 Spikes** | S1, S2, S3 (collector and mutation design), then S4, S6 | Results in `plans/spikes/`; D6 and D7 decided |
| **M2 Spec v1** | `spec/` with tiers, signals, rules, guardrails, and the input, report and config schemas; 30+ conformance cases | Cases cover every rule and guardrail and the input format, including negative cases. The adapter contract and the adapter conformance kit (one fixture project for node:test) are specified |
| **M3 Node build** | Engine, node:test collector (per-test coverage, per-file fallback), mutation (critical + changed lines), CLI `report`, `check`, `guard`, `plan`, `label`, `import` (Cupel's input format and JUnit XML), `validate`, `conformance`, and external collector commands in `cupel.json`, with `--json` | Passes all conformance cases; runs on Assay's suite end to end within a set time budget |
| **M4 Agents** | `cupel mcp` (stdio) with the five tools; docs for Claude Code, Cursor, Codex setup | An agent can call `cupel_check` and `cupel_guard` in a real session; S8 measured |
| **M5 CI** | GitHub Action running `guard` with a job summary | Blocks a PR that removes a critical test or lowers coverage, on a test repo |
| **M6 More runners** | Vitest and Jest collectors; pytest collector (`vibernt-cupel`) | Conformance passes; runs on CodeCrystal's pytest and hub-ts suites |
| **M6b More languages** | Collectors or importers for Java and Kotlin (JaCoCo, PIT), Go, .NET (coverlet, Stryker.NET), Rust (cargo llvm-cov, cargo-mutants), Ruby (Coverage, mutant) and PHP (php-code-coverage, Infection), in that order (D11); importers for coverage.py contexts and Stryker | Each ships as soon as it passes the conformance cases and the conformance cases and runs on one real open-source repository in its language, with the numbers recorded |
| **M6c Extension kit** | `docs/extending/` complete: schema references, worked examples for every extension point, adapter templates, the stability promise, CONTRIBUTING.md. Adapter conformance fixtures for every launch language | One adapter is built **only from the public docs** by an agent that may not read Cupel's source; every gap it hits is fixed in the docs |
| **M7 Launch** | Public repo, npm `@vibernt/cupel` and PyPI `vibernt-cupel` releases, the extension kit (M6c), launch post with results on Assay, CodeCrystal and the forks | Owner approves going public and publishing |
| **M8 Integrations** | `--assay` connector; CodeCrystal delivery integration | Opt-in only; Cupel still fully useful offline |

Order is strict for M0–M3. M4, M5, M6 and M6b can run in parallel once M3's CLI contract and the input format are stable. Launch (M7) covers JavaScript, TypeScript and Python; M6b languages ship after it, one by one (D11).
