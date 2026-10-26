# Pure engine flow result (2026-10-25)

## Method

The pre-edit `src/engine` and its analysis imports were copied to ignored
`.scratch/engine-flow/baseline/` before production edits. `differential.mjs`
stores complete `{report, exit}` results for every conformance case, a
deterministic generated corpus and the existing 65-row Express collector input.
The generated inputs are schema-validated. An initial generated corpus had
string shape tokens, which the schema rejects; it was corrected and recaptured
against the same frozen pre-edit engine. No expected result comes from the new
engine. The final oracle compares complete serialized results, including key
order and diagnostics, rather than selected fields.

The comparison covered 78 conformance cases, 35 generated command cases and
seven commands on the recorded input: **120/120 exact results**. The focused
engine/conformance tests passed, including four new tests for unknown-tag
diagnostics, Unicode and criticality group boundaries, file summary accounting,
and duplicate partner order. Both valid and negative conformance cases are in
the oracle.

`measure.mjs` warmed both engines once, then ran five alternating-order paired
samples on Node 26.7.0, Darwin arm64. Engine-only timings include `run()` and
report ordering, but exclude import, JSON file loading and CLI startup. Full
CLI timings are fresh child processes with `--input`/`--base-input` and JSON
output; they include startup, input reading, schema loading, engine and output.
The actual input has 65 rows. The synthetic scale input is schema-valid and has
10,000 units in 100 files, with one source per file. It is a stress case for
consolidation grouping, not a claimed real-repository workload. The raw five
pairs and frozen inputs/results are under ignored `.scratch/engine-flow/`.

| Workload | Baseline median | Current median | Observation |
| --- | ---: | ---: | --- |
| Actual 65, engine-only `report` | 7.06 ms | 7.17 ms | No measured gain |
| Actual 65, engine-only `guard` | 10.61 ms | 9.21 ms | 1.41 ms lower |
| Actual 65, engine-only `validate` | 5.75 ms | 4.43 ms | 1.33 ms lower |
| Synthetic 10,000, engine-only `report` | 777.93 ms | 535.96 ms | 241.97 ms lower (31.1%) |
| Actual 65, full CLI `report` | 73.24 ms | 71.39 ms | 1.86 ms lower |
| Actual 65, full CLI `guard` | 80.41 ms | 76.12 ms | 4.29 ms lower |

Memory was observed separately, in fresh Node processes after a synthetic
`report` run. Two baseline after-run RSS readings were 145.6 and 147.1 MB;
two current readings were 149.8 and 150.6 MB. These changes do **not** show a
memory improvement. RSS includes parsed input, loaded modules and the report;
it is not a measure of only the grouping algorithm. `memory.mjs` also reports
pre-run RSS and process peak RSS for each invocation.

## Changes and verdict

`guard` and `validate` now build the model and retain diagnostics without
running advice. They never emit or read advice/groups. The remaining commands
retain advice. Consolidation compares only units within nested file and
criticality buckets, preserving union-find identity, component sort and group
numbering. A10 finds the first qualifying duplicate once, without a partner
array or a second duplicate scan. File summaries group rows by file once.

This is a narrow, pure-engine improvement. The measured benefit is meaningful
for the labeled large grouping case; the 65-row CLI difference is small and
should not be described as a general end-to-end speedup. No new dependencies,
network paths, I/O, clock reads or randomness were added to the engine. No
production collector, CLI or S16 selective runner was changed by this slice.
Focused engine and conformance tests passed on Node 22.23.3 as well as Node
26.7.0; the timing measurements are Node 26 only. Full workspace verification,
installed-artifact checks, real selective PR behavior and any production
deployment remain outside this slice's verification; the parent task owns
those gates.
