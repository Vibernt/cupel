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
| D2 | Licence: **Apache-2.0**, chosen for its explicit patent grant between contributors and users (it does not cover third-party patents). `LICENSE` is the canonical text; `NOTICE` names the copyright holder, Vibernt | 2026-10-21 (owner) |
| D7 | Coverage granularity: **per-test is the v1 default for node:test.** One ordinary `node --test` run with an `--import` preload takes in-process V8 precise coverage (`node:inspector` `Session.connect()`, no port) between tests: about 1.4× a plain run on Assay ([S2](spikes/S2.md)). Per-file is the fallback, when the hook cannot attach, and the report's summary level. Per-test processes (`--test-name-pattern`, 4–11×) only re-check retire candidates and tests that spawn node, which removes the in-process method's first-touch bias and child-process blind spot. The data model keys coverage by test id with `granularity: "file" \| "test"`. The default scope is the whole repository minus `tests/`, `node_modules` and dot-directories ([S1](spikes/S1.md)). Verified on Node 22.23.3: hooks, counter reset and per-test attribution behave as on 26. Line sets differ slightly between Node versions, so `guard` must collect base and head on the same runtime | 2026-10-21, from S1 and S2 |
| D6 | JS parsing for mutation: **a zero-dependency textual lexer** for v1, with a standard-library validity filter (`vm.SourceTextModule`, falling back to `node --check`). On Assay it matches acorn on all 2 M tokens and on 99.85% of mutation sites, with no false sites and 0 invalid mutants ([S3](spikes/S3.md)). acorn 8.19.0 (MIT, one 235 KB file, no dependencies) is the fallback if ternary-condition mutants or JSX are needed. The TypeScript compiler API is rejected: about 56 MB, and its JS API is unstable. TypeScript sources are mutated after `module.stripTypeScriptTypes`, which keeps offsets. Mutants are served in memory through a module load hook, never written to disk, so source-text pins earn no kills. A kill counts only when a test reports a failure; a crash is an environment error | 2026-10-21, from S3 |
| D10 | **The engine's input format is public**: a versioned JSON Schema in the spec, beside the report schema. `cupel import` reads it and supported tool formats. Every collector, native or third-party, emits it; existing mutation and coverage tools are imported rather than re-implemented. This is how Cupel reaches languages beyond JS and Python | 2026-10-21 (owner) |
| D11 | **Languages:** launch with JavaScript, TypeScript and Python. Then add Java and Kotlin, Go, .NET, Rust, Ruby and PHP, in that order, shipping each as it passes its conformance cases and a real-repository run | 2026-10-21 (owner) |
| D12 | **Frameworks:** coverage and mutation are built once per language. Per-file coverage works for every framework with no framework code. Per-test coverage uses a thin framework adapter that implements a contract in the spec (list, select, boundaries, tags) | 2026-10-21 |
| D13 | **Extensibility is first-class.** People extend Cupel through config (tier rules, brittleness patterns), the public input format, external collector commands and framework adapters, all **outside Cupel's process**: no third-party code is loaded into Cupel. Extensions prove themselves with the adapter conformance kit; `docs/extending/` documents every extension point, and one adapter is built from the docs alone before launch | 2026-10-21 (owner) |

## Dependencies

There are none yet. Each dependency must be pinned to an exact version and justified here; `scripts/check.mjs` enforces both.

## Open

| Id | Question | Recommendation |
|---|---|---|
| D3 | Coverage target wording | 100% line and branch on critical modules, a ratchet elsewhere |
| D4 | Default critical paths | auth, permissions, tenancy, tokens, secrets, egress, billing, quotas, migrations, backups, deletion, public API; **after S6, also** credential, crypto, leak, unsafe, sign-in, login, security, isolation, sandbox, privacy, integrity, redact, inject, traversal, hardening, admission, budget; plus title tags such as negative, tamper, forged, refuse, permission, token, secret. "Covers any critical line" guards against retirement; name, tag or unique critical lines decide run order ([S6](spikes/S6.md)) |
| D5 | Retirement threshold | **Revised after S6: never retire on coverage alone.** Retire only when the test is not critical, ran and passed, has no unique line after the per-process re-check, **and** has no unique kill under targeted mutation of its own covered lines (missing mutation data is not "no kill"), or has a near-duplicate body in a test that covers all its lines. Otherwise report "no unique coverage (unverified)" as a review hint, never as advice. In S6, coverage-only retire advice was right 1 time in 20 ([S6](spikes/S6.md)). History ("no real catch in 90 days") arrives with Assay |
| D8 | First runners | node:test first; then Vitest, Jest, pytest |
| D9 | Report schema versioning | `cupel-spec/1`, semver-style, breaking changes bump the major |
