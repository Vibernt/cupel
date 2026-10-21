## Cost per file (median of repeats, min–max in brackets; ms)

| File | Tests | Plain `node --test` wall | Plain CPU | B wall | B CPU | B / plain (wall) | A wall (sum of per-test runs) | A CPU | A / plain (wall) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| drop-in.test.mjs | 59 | 3770 (3717–4507) | 2250 (2170–2640) | 4540 (4398–4666) | 2990 (2880–3110) | 1.20× | 33855 (24124–42349) | 30060 (25030–36300) | 9.0× |
| previews.test.mjs | 27 | 688 (618–758) | 750 (710–830) | 816 (810–941) | 910 (900–1040) | 1.19× | 7699 (6279–12579) | 8190 (7090–10650) | 11.2× |
| fanout.test.mjs | 36 | 3580 (3529–3935) | 4020 (3950–4330) | 6003 (5928–6390) | 6450 (6420–6720) | 1.68× | 14209 (12635–24725) | 14640 (13950–19710) | 4.0× |
| **all three** | 122 | 8464 | 7370 | 11536 | 10500 | 1.36× | 62683 | 58440 | 7.4× |

## Cost per test (ms)

| File | A: per-test process wall, median (min–max) | A: per-test CPU, median | A: coverage → lines, per test | B: extra wall per test vs plain | B: extra CPU per test | B: one take | B: takes per test | B: ranges → lines, per test |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| drop-in.test.mjs | 497 (277–1681) | 500 | 17.1 | 13.1 | 12.5 | 4.32 | 2.1 | 3.6 |
| previews.test.mjs | 245 (196–656) | 280 | 9.3 | 4.7 | 5.9 | 2.97 | 2.1 | 0.5 |
| fanout.test.mjs | 282 (187–8157) | 310 | 7.3 | 67.3 | 67.5 | 2.30 | 2.1 | 0.4 |

## Where B's overhead comes from (wall ms, median of repeats)

| File | direct `node file` | plain `node --test` | + hooks only | + precise coverage on, no takes | + takes (method B) | sum of take times | raw output written |
|---|---:|---:|---:|---:|---:|---:|---:|
| drop-in.test.mjs | 3810 | 3770 | 3821 | 3884 | 4540 | 523 | 7.4 MB in 11 ms |
| previews.test.mjs | 581 | 688 | 655 | 639 | 816 | 169 | 1.3 MB in 2 ms |
| fanout.test.mjs | 3641 | 3580 | 3620 | 5728 | 6003 | 172 | 1.5 MB in 2 ms |

## Agreement and unique lines per file

| File | Tests | Jaccard raw, mean (min) | Jaccard test-only, mean (min) | Tests with test-only Jaccard ≥ 0.95 | Unique lines A | Unique lines B | Zero-unique tests A | Zero-unique tests B | Same zero/non-zero verdict | File-level unique lines A | File-level unique lines B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| drop-in.test.mjs | 59 | 1.00 (0.99) | 0.98 (0.94) | 56 | 754 | 828 | 20 | 19 | 58/59 | 11686 | 11686 |
| previews.test.mjs | 27 | 1.00 (1.00) | 1.00 (1.00) | 27 | 118 | 118 | 11 | 11 | 27/27 | 775 | 775 |
| fanout.test.mjs | 36 | 1.00 (1.00) | 1.00 (0.98) | 36 | 1552 | 1551 | 11 | 11 | 36/36 | 3063 | 3063 |
| **all three** | 122 | 1.00 | 0.99 | 119 | 2424 | 2497 | 42 | 41 | 121/122 | 15524 | 15524 |

## Per-file versus per-test unique lines (method A; uniqueness across the three files)

| File | Tests | Lines unique to the file | of which not module-load lines | of which covered by exactly one test | Share pinned to one test | Tests with zero unique lines |
|---|---:|---:|---:|---:|---:|---:|
| drop-in.test.mjs | 59 | 11686 | 4410 | 754 | 17% | 20 |
| previews.test.mjs | 27 | 775 | 775 | 118 | 15% | 11 |
| fanout.test.mjs | 36 | 3063 | 3033 | 1552 | 51% | 11 |

## Lines per file process (covered src/** and public/** lines)

| File | All lines, A (union of runs) | All lines, B (one process) | Setup A (module load) | Setup B (all non-test segments) | of which before the first test | of which between tests |
|---|---:|---:|---:|---:|---:|---:|
| drop-in.test.mjs | 25974 | 25974 | 20915 | 20915 | 20915 | 0 |
| previews.test.mjs | 14771 | 14771 | 13577 | 13577 | 13577 | 0 |
| fanout.test.mjs | 16270 | 16270 | 12667 | 12677 | 12667 | 0 |

## Disagreements

Tests where B gives the test lines that A's run of that test does not cover: 0 (lines: 0).
Tests where A covers lines that B gives to no part of the test or its file's setup: 62 (lines: 3616).
Tests whose unique-line sets differ between A and B: 4. Lines unique in B but not in A: 74 (in 3 tests); unique in A but not in B: 1 (in 1 tests).
- drop-in.test.mjs :: queued -> admitted -> JIT registration -> one container -> in_progress -> exit: billed per: unique A 0, unique B 25 (B only 25, A only 0)
- drop-in.test.mjs :: container egress: the runner starts without internet under allowlist, its cache token goes: unique A 43, unique B 58 (B only 15, A only 0)
- drop-in.test.mjs :: start latency: each moment from GitHub queued to started is recorded on the job, and the p: unique A 2, unique B 36 (B only 34, A only 0)
- fanout.test.mjs :: a stored copy that is tampered, truncated, extended, re-keyed or replaced while read fails: unique A 12, unique B 11 (B only 0, A only 1)

| Test | File | A lines | B lines | Jaccard test-only | B not A | A not B | Unique A | Unique B |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| capacity at start: a burst is spaced per pool, retries back off briefl… | drop-in.test.mjs | 23380 | 2565 | 0.94 | 0 | 141 | 8 | 8 |
| API: drop-in usage is per second, and a month that spans the change sa… | drop-in.test.mjs | 22865 | 2070 | 0.95 | 0 | 101 | 1 | 1 |
| evidence on the job: a swapped job gets the start moments of the runne… | drop-in.test.mjs | 23705 | 2917 | 0.95 | 0 | 141 | 4 | 4 |
| a burst refused for capacity retries spaced: each retry takes a start … | drop-in.test.mjs | 23157 | 2374 | 0.95 | 0 | 107 | 1 | 1 |
| capacity sweep: a lease or waiter whose runner object is gone or concl… | drop-in.test.mjs | 23219 | 2437 | 0.96 | 0 | 100 | 42 | 42 |
| API: the job list and usage are workspace-wide (run.read); cancel need… | drop-in.test.mjs | 23497 | 2734 | 0.96 | 0 | 111 | 202 | 202 |
| negative: a retirement names the runner's own workspace; a wake change… | drop-in.test.mjs | 23243 | 2466 | 0.96 | 0 | 100 | 0 | 0 |
| a runner whose job GitHub gave to an earlier start attempt, now gone, … | drop-in.test.mjs | 23373 | 2614 | 0.96 | 0 | 100 | 3 | 3 |
| GitHub's completed for another job never ends a runner, and a runner p… | drop-in.test.mjs | 23552 | 2795 | 0.96 | 0 | 107 | 11 | 11 |
| a container this object cannot stop is stopped later, and an object th… | drop-in.test.mjs | 23597 | 2837 | 0.96 | 0 | 107 | 15 | 15 |
| start latency: each moment from GitHub queued to started is recorded o… | drop-in.test.mjs | 23311 | 2540 | 0.96 | 0 | 95 | 2 | 36 |
| an idle runner left after its job ran elsewhere is retired within a mi… | drop-in.test.mjs | 23750 | 2998 | 0.96 | 0 | 107 | 0 | 0 |

## Child processes, nesting, concurrency

Tests that start a child process or worker (B cannot see their coverage): 0 of 122.
A runs with more than one coverage file (a child node process wrote coverage): 0.
Nested subtests seen: 0. Shared (concurrent) segments: 0.

## Stability across repeats (Jaccard of a test's lines, repeat 1 vs the others)

A: mean 1.00, min 1.00, below 1: 0 of 244.
B: mean 1.00, min 1.00, below 1: 1 of 244.

Correctness checks: A runs that did not run exactly one passing test (or, for setup, ran a test): 0. B coverage runs with failures: 0.
