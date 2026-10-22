# M3: Cupel end to end on Vibernt Assay

This is the first full run of `cupel report` on a real suite: collection, mutation on critical code, a per-process re-check of retire candidates, targeted mutation on their own lines, and the final advice.

## Setup

| Item | Value |
|---|---|
| Suite | Vibernt Assay `origin/main` 5a5a1313, a fresh copy of the snapshot (read-only, and `git status` clean afterwards) |
| Tests | `tests/*.test.mjs` (Assay's own glob): 421 files |
| Cupel | `main` at a87ebb1 (engine, node:test collector, mutation, CLI) |
| Config | `runners.node.tests: "tests/*.test.mjs"`, `mutation.maxMutants: 1500`, `mutation.maxSeconds: 2400`; everything else at defaults (D4 critical words, D5 retire rule) |
| Machine | Apple M2 Max, 12 cores, Node 26.7.0. The load was moderate; other sessions were running |

## Stages

| Stage | Result | Time |
|---|---|---|
| Collection, run 1 (per-test coverage) | 4,724 tests, 4,723 passed | 44.1 s (plain run: 39 s, so about 1.13× on this pass) |
| Collection, run 2 (durations, spawn detection) | 4,722 passed; 1 flaky failure (`demo-workspace`, known from S4) | 36.5 s |
| Mutation on critical code | 15,479 valid sites; 363 run before the time cap, sampled with seed 20261021 | 2,400 s (cap), 6 processes, 9 mutants/min |
| Re-check of retire candidates | 1,465 units, each in its own process; all 1,465 re-checked | 44 s |
| Targeted mutation | 73,717 sites on candidates' own lines; 882 run, taken as whole units, smallest first; 102 units with complete evidence | 2,400 s (cap), 22 mutants/min |
| Confirming survivors (K7) | 99 survivors re-run twice | (included above) |
| **Total** | | **5,686 s (95 min)** |

## Report

| Measure | Value |
|---|---|
| Units | 4,295 |
| Line coverage | 82.22 % (191,377 of 232,745) |
| Critical line coverage | 82.80 % (17,023 of 20,558) |
| Mutation score, all mutants run | 78.71 % (980 of 1,245) |
| Mutation score, critical code (sample of 363) | **54.26 %** |
| Advice | keep 3,939; consolidate 8; rewrite 173; retire **48**; none 127 |
| Hints | `no-unique-coverage-unverified` 1,358; `no-coverage-evidence` 125; `spawns-interpreter` 48; `retire-conflict` 2 |

**Retire.** All 48 came by the mutation path (`no-unique-lines`, `no-unique-kills`), out of the 102 units with complete targeted evidence. Whether they are right is spike S6b, judged by two models from different families.

## Notes

- **Critical mutation was slower than in the smoke run.** It managed 9 mutants/min with 6 processes, against 17 with 2 processes in the smoke run on the same scope. Likely causes are contention or a different seeded draw hitting slow test files. Not yet investigated.
- **Most retire candidates stayed unverified.** At 22 targeted mutants/min, giving all 1,465 candidates complete evidence would take about 73,717 / 22 ≈ 56 hours. Cupel therefore gives complete evidence to the smallest units first, and keeps the rest as unverified hints, never as retire.
- **The time budget is set by config.** With mutation off, a report takes about 90 s.
