# Cupel plans

**Cupel**: know which tests protect you. A cupel is the dish assayers use in cupellation: it shows what a sample is really made of. Cupel assays a test suite: which tests actually catch faults, where the gaps are, and whether a change has weakened it.

An open-source, local-first tool for people and coding agents. It measures each test's worth, labels tests critical, standard or minor, finds the faults no test catches, advises keep, consolidate or rewrite (never remove: D5), guards every change to the suite, and runs tests by priority. A CLI, a local MCP server and a GitHub Action: no UI, no hosted service, no analytics, no telemetry.

Built fully independent first. Vibernt Assay (history, gates, dashboards) and CodeCrystal (the agent authoring loop) integrate with it later.

| File | What it holds |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Why it exists, scope, principles, tiers, how it feeds Assay and CodeCrystal |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Spec, engine, collectors, CLI, MCP tools, GitHub Action, report format, config |
| [SPIKES.md](SPIKES.md) | Eight time-boxed spikes that prove the scoring before the build |
| [ROADMAP.md](ROADMAP.md) | Milestones from first commit to public launch, with done criteria |
| [DECISIONS.md](DECISIONS.md) | Locked and open decisions |
| [RESEARCH.md](RESEARCH.md) | What the research found: the problem, the market, the two source codebases |
| [research/market-2026-10-21.md](research/market-2026-10-21.md) | The full market scan with sources |
| [KICKOFF.md](KICKOFF.md) | The prompt that starts the build in a new Claude Code session |

Background pages (private, on the owner's claude.ai): the [lean test suites plan](https://claude.ai/artifact/EXS1Ps2TQG9xxszv3zpns4) and the [market scan](https://claude.ai/artifact/8QgTjWv3xzDNSHFDDZCPwm).
