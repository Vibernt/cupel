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

## Dependencies

There are none yet. Each dependency must be pinned to an exact version and justified here; `scripts/check.mjs` enforces both.

## Open

| Id | Question | Recommendation |
|---|---|---|
| D3 | Coverage target wording | 100% line and branch on critical modules, a ratchet elsewhere |
| D4 | Default critical paths | auth, permissions, tenancy, tokens, secrets, egress, billing, quotas, migrations, backups, deletion, public API |
| D5 | Retirement threshold | No unique coverage and no unique kill (history-based "no real catch in 90 days" arrives with Assay) |
| D6 | JS parsing for mutation | Decide after S3: a small vetted parser (acorn) vs TypeScript compiler API vs textual mutation. Zero dependencies preferred; any dependency must be pinned and justified |
| D7 | Per-test vs per-file coverage in v1 | Decide after S1 and S2 |
| D8 | First runners | node:test first; then Vitest, Jest, pytest |
| D9 | Report schema versioning | `cupel-spec/1`, semver-style, breaking changes bump the major |
