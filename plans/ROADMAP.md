# Roadmap

| Milestone | Contents | Done when |
|---|---|---|
| **M0 Kickoff** | Private repo `Vibernt/cupel`, licence file (Apache-2.0 unless D2 changes), README stub, AGENTS.md and CLAUDE.md, local checks run by a pre-push hook (no hosted CI for the repo itself; owner, 2026-10-21), plans moved in | Repo exists, `npm run verify` green, plans committed |
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
