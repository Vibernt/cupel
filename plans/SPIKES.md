# Spikes

Each spike answers one risky question before the build commits to it. Run them read-only against real suites; never change those repositories. Record results in `plans/spikes/<id>.md` (numbers, method, verdict).

Source suites (local checkouts, read-only):
- Vibernt Assay: `/Users/vid/cri-ci` (origin/main). ~4,300 Node tests in 421 files, 163 workerd, 677 Python. Node 22+, `node --test tests/*.test.mjs`; run with `PATH=/opt/homebrew/bin:$PATH` (system python 3.9 breaks ~40 tests); `npm run -s test:quiet` prints only failures.
- CodeCrystal: `/Users/vid/codecrystal`. 1,587 pytest tests (`.venv/bin/python -m pytest -q -m "not load" --ignore-glob='tests/test_ai_cv_*'`), hub-ts Vitest ~2,000, web Vitest ~230.
- Benchmark forks (owner's GitHub `vidhatanand/mastra`, `vidhatanand/better-auth`): clone locally into a scratch folder; keep the forks' GitHub Actions off.

| Id | Question | How | Done when | Box |
|---|---|---|---|---|
| S1 | How much of a suite adds no unique coverage? | Run each Node test file alone with `NODE_V8_COVERAGE`; build line sets; count lines covered by exactly one file (Assay's suite) | Table of files with zero unique lines; collection time | 1 day |
| S2 | Can we get per-test (not per-file) coverage cheaply? | On 3 large Assay files (drop-in, previews, fanout): per-test runs via `--test-name-pattern` vs V8 inspector `takePreciseCoverage` between tests | Unique lines per test; cost per test; go/no-go | 1 day |
| S3 | Do the tests actually detect faults in critical code? | Small mutator over Assay's permissions, agent-connect and billing modules; run the selected tests per mutant | Mutation score per module, survivors, tests with unique kills; mutants per minute | 2 days |
| S4 | Can one area shrink without losing anything? | On a copy (worktree) of Assay: merge `ui-pipelines`, `ui-pipelines-v2`, `ui-pipelines-volt` (42 tests) into one file; replace source-text pins | Tests and lines down, runtime down, coverage and S3-style score equal or better | 1 day |
| S5 | Do tier labels work end to end? | Path-rule config plus title tags on Assay; a reporter writes the tier into JUnit properties; "critical only" run | Critical-only count and time; tiers in JUnit | 1 day |
| S6 | Is advice credible to a person? | Run the draft engine on Assay and CodeCrystal; hand-check 30 suggestions each | Precision of retire/consolidate advice; false positives explained | 1 day |
| S7 | What do CodeCrystal's 439 experiment-harness tests protect? | Coverage of `scripts/*` harnesses vs product code | Per harness: keep, move to opt-in, or retire | ½ day |
| S8 | Does an agent add fewer no-value tests with `cupel check`? | On 10 recent agent-written PRs (Assay, forks), unique coverage of the new tests on changed lines; then a small A/B with an agent using the MCP tool | Share of no-value tests with and without; false positive rate | 1 day |

S1, S2, S3 decide the collector design; S4 and S6 decide whether advice is trustworthy enough to ship; S8 is the launch story.
