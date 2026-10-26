# S19 results: mutation coverage selection

Verdict: **no product change**. Repeated coverage parsing inside `Session.select`
is measurable, but it did not reach the predeclared 10 ms and 5% whole-call
gate in any complete request. Rust remains deferred.

## Complete requests

The [S19 plan](../S19.md) froze the current 19-file mutation tree at
`9e24423e3e5f3674d5608dcd7b84d31bf278b26e16bb79820b6e9caf9b12646f`
before copying the runtime. The final copy also pins the full source tree,
schemas and `engine/lines.mjs`; see
[runtime manifest](../../../.scratch/s19/runtime-5vPupQ/manifest.json).
Each row below is a median of three alternating pairs after one warmup per
method. Cupel chose **6 jobs** on both runtimes. Complete mutation and required
survivor confirmation objects, legacy counters, and actual test/Jest/validity
launches matched between control and instrumented copies.
These default-job measurements are not a speedup comparison with S17's
forced single-job timings; the product was unchanged.

| Runtime and workload | Control whole wall | Selection inclusive | Whole share | Repeated parse | Repeated share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 26, existing node:test | 339.187 ms | 0.309 ms | 0.091% | 0.088 ms | 0.026% |
| Node 26, existing Jest | 1400.782 ms | 0.142 ms | 0.010% | 0.026 ms | 0.002% |
| Node 26, synthetic executable source-heavy | 501.480 ms | 0.474 ms | 0.094% | 0.180 ms | 0.036% |
| Node 22, existing node:test | 508.796 ms | 0.352 ms | 0.069% | 0.085 ms | 0.017% |
| Node 22, existing Jest | 1546.561 ms | 0.224 ms | 0.014% | 0.020 ms | 0.001% |
| Node 22, synthetic executable source-heavy | 775.357 ms | 0.579 ms | 0.075% | 0.186 ms | 0.024% |

Actual launches per complete diagnostic request were node:test **10**, Jest
**0**, validity **2** for the node:test fixture; node:test **0**, Jest **4**,
validity **2** for Jest; and node:test **16**, Jest **0**, validity **3** for
the synthetic source-heavy fixture. Both methods had the same launches on
Node 22 and 26. Selection calls in mutation/confirmation were 12/3, 4/0 and
16/9 respectively. Calibrated clock-pair overhead was 54.51 ns on Node 26 and
56.35 ns on Node 22; estimated aggregate clock overhead for these selectors
was under 0.008 ms. This estimate is not a strict upper bound. The results are
far below both gates, so the outer-only timer and five-pair extension were not
needed.

Raw accepted-fixture captures: [Node 26](../../../.scratch/s19/profile-EGUXJ9/results.json),
[Node 22](../../../.scratch/s19/profile-eQg53C/results.json); separate
launch diagnostics: [Node 26](../../../.scratch/s19/launch-l932li/result.json),
[Node 22](../../../.scratch/s19/launch-WHBIzc/result.json). Earlier
`final-node*` fixture captures remain historical; the final runs use accepted
`approved9e-node*` inputs. Parent CPU, RSS and retained heap measurements are
in the raw captures, separately from wall time.

## Saved Express input replay

Only the saved 65-row collector input was read. Its raw SHA-256 is
`de0915855549d16d31251d4a313b8fcb70603625a2903a44b39aeedd4446bce2`.
It contained 3,396 unique coverable source/line queries, of which 564 were
covered by saved test, setup or file evidence. The replay sampled **200
distinct covered and coverable queries**, each once, across 75 sources. The
instrumented and control `Session.select` agreed on IDs, file counts, order
and targeted behavior for every query; 107 had selected test rows and 27
required targeted full runs. Selection took 12.636 ms on Node 26 and 14.372 ms
on Node 22, including repeated parse time of 10.712 and 11.410 ms. This is a
**kernel-only input replay**, with no collection, mutation, confirmation or
whole-call denominator. It cannot satisfy the product gate.

Replay evidence: [Node 26](../../../.scratch/s19/express-replay-0NvLhL/result.json),
[Node 22](../../../.scratch/s19/express-replay-WiCn2v/result.json).

## Checks and next action

Eight targeted S19 tests passed on Node 26 and Node 22. They cover source-pin
and transform refusals, counter reset and conservation, unique covered-query
sampling, and actual selector parity. Complete requests and launch diagnostics
passed on both runtimes. Product source, installed private artifacts and the
saved Express checkout were not changed. The next best action is to use the
accepted private full-guard candidate and leave mutation selection as it is.
Reopen optimization when an actual slow job provides a different whole-call
profile; no further profiling round is scheduled from this result. No general
speedup is claimed from this experiment.
