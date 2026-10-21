# Product

## The problem

Coding agents write most new tests now, and a lot of them. Suites grow faster than anyone reviews them: several files per feature, tests that assert on source text, tests that run code without checking it, slower CI and more flakes. From the research ([RESEARCH.md](RESEARCH.md)): agents touch tests in 23% of commits (13% for people) and add more mocks; their tests raise coverage in only 22–36% of PRs; suites can show 100% line coverage with a 4% mutation score; LLM-written tests average about 40%.

Existing tools each cover one slice: flaky-test detection, test selection, coverage gates, mutation testing, test generation. **Nobody judges what each test is worth, and nobody recommends retiring tests.** Selection tools skip tests but never remove them, so suites only grow.

## What Cupel is

A local-first, open-source tool for people and coding agents:

- **Measure** each test's worth: unique coverage, unique mutation kills, redundancy, cost, brittleness.
- **Label** tests critical, standard or minor (path rules plus in-test tags).
- **Advise** keep, consolidate, rewrite or retire, with an evidence report.
- **Guard** every change that removes or rewrites tests: coverage never falls, the mutation score on critical code never falls, no critical test is removed.
- **Prioritise** runs: critical first, then tests affected by the change, then the rest.
- **Talk to agents** through a local MCP server, so an agent can ask "does this new test add anything?" before it commits.

Delivered as a CLI (`cupel`), a local MCP server (stdio) and a GitHub Action that runs the guard in CI.

## Out of scope (locked)

- No UI, no dashboards, no hosted service.
- No analytics and no telemetry of any kind. Cupel never phones home.
- No model calls. Cupel is deterministic; the user's own coding agent does any rewriting, using Cupel's tools.
- No run history across machines. Cupel scores from what it can measure now (coverage, mutation, the code). History is what Vibernt Assay adds.

## Principles

1. **A test earns its place** by covering code nothing else covers, killing mutants nothing else kills, having caught a real regression, or guarding something critical.
2. **Coverage is not enough.** Coverage is always paired with mutation detection on critical code.
3. **The agent never grades its own tests.** The guard runs in CI (the GitHub Action), outside the agent's write scope. Agents propose; people approve retirements and anything critical.
4. **Deterministic and offline.** Same inputs, same report; works without a network.
5. **Small and dependable.** Minimal dependencies, each one justified ([DECISIONS.md](DECISIONS.md) D6).
6. **Language-neutral by spec.** One spec and shared conformance cases; every language implementation must pass them.
7. **"100% coverage", made precise.** 100% line and branch coverage on critical modules, a ratchet everywhere else, and an equal-or-better mutation score whenever tests are removed.

## Tiers

| Tier | What belongs | How it runs |
|---|---|---|
| critical | Security and trust boundaries, money, data loss, migrations, public API contracts, negative tests on trust boundaries | Always and first. Never auto-retired; removal or downgrade needs a person |
| standard | Core behaviour | When affected by a change; everything on main |
| minor | Copy, layout, doc pins, cosmetic assertions | Only when their own files change; main and nightly. First candidates for consolidation |

## How Cupel feeds Vibernt Assay and CodeCrystal (later, not in the first build)

- **Vibernt Assay** (paid): run history (which tests actually caught regressions, confirmed by bisection), flakiness, deploy gates on critical tests, tier-aware test selection, team dashboards. Connected with one opt-in flag (`--assay`): reports upload, history comes back. Assay is the judge with memory.
- **CodeCrystal**: bundles the engine; its agents call Cupel's tools before every delivery; gardening proposals become delivery tasks.
- Cupel stays fully useful without either. The connectors are opt-in and are the only network calls Cupel ever makes.

## Audience

- Teams using Claude Code, Cursor, Codex or similar at scale, watching CI time and review load climb.
- First languages: JavaScript/TypeScript (node:test, Vitest, Jest) and Python (pytest). Then Java and Kotlin, Go, .NET, Rust, Ruby and PHP, in that order, through collectors and importers that emit the public input format (D10, D11). Every framework works at file level; popular frameworks get per-test adapters (D12).
- Advice is weakest for end-to-end and browser tests that span services: Cupel labels, guards and orders them, but marks their keep/retire advice as low evidence.

## Success at launch

- Published results on real repositories (Vibernt Assay's 5,000-test suite, CodeCrystal, and the mastra and better-auth benchmark forks): redundant tests found, unique mutation kills, CI minutes recoverable, with no coverage or mutation loss.
- An agent using Cupel's MCP tools adds measurably fewer no-value tests than one without (spike S8).
