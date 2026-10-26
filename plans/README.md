# Cupel plans

**Cupel**: know which tests protect you. A cupel is the dish assayers use in cupellation: it shows what a sample is really made of. Cupel assays a test suite: which tests actually catch faults, where the gaps are, and whether a change has weakened it.

A private, MIT-licensed local tool for people and coding agents. It measures test evidence, labels tests critical, standard or minor, finds observed protection gaps, and compares suite changes. It never advises test removal (D5). Selective PR execution remains experimental and outside the supported first release. Public launch is a future owner decision.

## Current release and implementation

Start with [the support contract](../docs/support.md) for accepted capabilities
and [the documentation index](../docs/README.md) for usage.

| File | What it holds |
| --- | --- |
| [FIRST-RELEASE-CHECKLIST.md](FIRST-RELEASE-CHECKLIST.md) | Release scope and verification gates |
| [RELEASE-READINESS.md](RELEASE-READINESS.md) | Acceptance status and remaining limits |
| [RUNNER-COMPLETION.md](RUNNER-COMPLETION.md) | Runner evidence and selective-execution boundaries |
| [PERFORMANCE-FLOW.md](PERFORMANCE-FLOW.md) | Reuse, measurement and deferred optimization decisions |
| [results/](results/) | Dated acceptance and benchmark audits |
| [spikes/](spikes/) | Reproducible research methods, raw results and refusals |

## Design and historical context

The documents below include original goals. Current acceptance and owner
decisions take precedence over unfinished roadmap items and old prompts.

Built fully independent first. Vibernt Assay (history, gates, dashboards) and CodeCrystal (the agent authoring loop) integrate with it later.

| File | What it holds |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Why it exists, scope, principles, tiers, how it feeds Assay and CodeCrystal |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Spec, engine, collectors, CLI, MCP tools, GitHub Action, report format, config |
| [SPIKES.md](SPIKES.md) | Original pre-build research plan; subsequent work is in spikes/ |
| [ROADMAP.md](ROADMAP.md) | Milestones from first commit to public launch, with done criteria |
| [DECISIONS.md](DECISIONS.md) | Locked and open decisions |
| [RESEARCH.md](RESEARCH.md) | What the research found: the problem, the market, the two source codebases |
| [research/market-2026-10-21.md](research/market-2026-10-21.md) | The full market scan with sources |
| [KICKOFF.md](KICKOFF.md) | Historical original prompt, superseded by current decisions |

Background pages (private, on the owner's claude.ai): the [lean test suites plan](https://claude.ai/artifact/EXS1Ps2TQG9xxszv3zpns4) and the [market scan](https://claude.ai/artifact/8QgTjWv3xzDNSHFDDZCPwm).
