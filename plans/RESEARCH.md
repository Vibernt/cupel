# Research summary (2026-10-21)

Full market scan with sources: [research/market-2026-10-21.md](research/market-2026-10-21.md).

## The problem is measured

- Agents touch tests in 23% of commits (13% for people); 36% of agent test commits add mocks (26%). 1.2M commits ([arXiv 2602.00409](https://arxiv.org/abs/2602.00409)).
- Agent tests raise coverage in only 22.5% (Python) and 35.9% (Java) of PRs that change tested code ([arXiv 2607.18057](https://arxiv.org/abs/2607.18057)).
- Writing tests barely changes agent success; discouraging tests cut one model's input tokens by 49% ([arXiv 2602.07900](https://arxiv.org/html/2602.07900v2)).
- 100% coverage can sit next to a 4% mutation score ([arXiv 2506.02954](https://arxiv.org/abs/2506.02954)); twelve LLMs averaged a 40.2% mutation score ([arXiv 2508.00408](https://arxiv.org/pdf/2508.00408)).
- Teams already prune by hand: one removed ~300 tests and 5,000+ lines with one cleanup prompt.

## The market

- Flaky tests: Datadog ($20–29/committer/mo), Trunk, BuildPulse, Mergify, Buildkite ($0.10/unique test/mo).
- Test selection: CloudBees Smart Tests (ex-Launchable), CircleCI Smarter Testing (GA 2026-10-13), Develocity, Harness.
- Coverage: Codecov ($12/user), GitHub Code Quality ($10/committer; GA 2026-07-20; the biggest bundling threat).
- Mutation: Stryker, PIT, mutmut; Arcmutate (JVM, per-test statistics).
- Test generation and review: Qodo (Cover unmaintained since mid-2025), Diffblue, CodeRabbit, Meticulous.
- Closest open source: Tobari (Go, ranks overlapping tests), AdversaryGate (pytest, mutation-tests an agent's patch).
- **Gap: no product scores per-test worth, recommends retiring tests, or gives agents write-time "is this test worth adding" feedback across languages.**

## What the source codebases have (useful for spikes and later integration)

**Vibernt Assay** (`/Users/vid/cri-ci`):
- Its own suite: 5,135 declared tests in 511 files; Node suite 405–883 s per CI run on 2 vCPU, now 2 shards. 100 console test files with overlapping families (`ui-pipelines`, `-v2`, `-volt`); 61 files assert on source text.
- A test-count guard (`scripts/test-counts.mjs`, `--accept-loss`) that blocks silent test deletion.
- `npm run test:coverage` (Node built-in coverage), never run in CI. No priority labels; precedents `[fault:<id>]` titles and the `negative:` prefix.
- Product test intelligence: per-test history (executions, fails, flips, durations, last failure), co-failure pairs, bisection, flakiness and quarantine, selection with holdout and a replay gate, sharding, a file-level test→source coverage map (`runner/tia_coverage.py`, `NODE_V8_COVERAGE` per test file, pytest-cov contexts, istanbul JSON).

**CodeCrystal** (`/Users/vid/codecrystal`):
- Python 1,587 tests (28% cover historical experiment scripts), hub-ts ~2,000 Vitest, web ~230, Rust 296. No coverage tooling; one unused `load` marker; CI runs the full pytest suite 12 times.
- A static test↔code map: graph `tests` edges and `tests_for()` (98.7% precision on itself), learned `tested_by` links, `cri test` with local flaky and slow detection.
- Agent test rules in the planner's `TEST_DESIGN` skill and language packs ("never edit, skip or weaken the acceptance tests").
