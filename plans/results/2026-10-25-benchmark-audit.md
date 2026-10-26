# Benchmark evidence audit — 2026-10-25

The saved timings did not bind measurements to exact source/Cupel revisions,
configuration, runner sets and test inventories. Some baselines timed only a
primary runner while reports included several runners.

Repairs in `bench/` record identity for new stages, inventories and runner counts
for collected inputs, mutation status counts from the actual report stage, and
selected-duration estimates for new plan replays. The report generator no longer
mixes saved stage results with a candidate's potentially unrelated current input.
It preserves failed/missing stages and separate earlier `all` attempts.

The regenerated `bench/BENCHMARK.md` classifies:

- Go: invalid comparison, 1,068 baseline tests versus 1,077 collected.
- Zotero: invalid comparison, 4,225 baseline rows versus 4,474 collected.
- Other historical successful runs: unverified overhead, missing provenance.
- Failed/unrun candidates: visibly failed/unrun, with their reasons.

Raw timings remain available. No historical ratio has been converted into a
verified speed claim, no failing runner was omitted, and no large benchmark was
rerun. Cold/warm observations, wall time and summed test durations remain distinct.

Validation: 31 focused benchmark tests, repository rule checks and whitespace
checks passed. New Docker stage capture has not been exercised live, so its
runtime acceptance remains unverified. Exact machine-readable baseline IDs still
need runner-specific collection before new mixed-suite comparisons can become
verified; matching counts alone are insufficient.

Next best action: use a small, explicitly scoped equivalent-runner measurement
when a speed claim is needed. Do not repeat all ten repository runs just to
replace honest unavailable/unverified results.
