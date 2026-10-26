# S17 mutation source-analysis measurement

This is a local, ignored-output experiment. Product mutation code is in
`packages/cupel/src/mutate/`; this directory only prepares fixtures, checks
whole mutation output, and measures legacy, guards-only and guards+reuse
implementations. The guards-only source is a separately pinned ignored scratch
snapshot; it preserves the repaired path/freshness guards while disabling only
the source-fact reuse being attributed.

The first changed-source hash `53a8f654…` is **revoked** after a source path
containment/privacy issue was found. Its exact Node 22/26 parity and Node 26
diagnostic evidence remain at `.scratch/s17/final-node{22,26}/`, but no warm
acceptance timing was run against it. The repaired `9e24423e…` source hash was
independently recomputed before approval. `frozen-source.json` must have
`status: "approved"` and a matching source digest before either comparison or
diagnostic harness runs again. The guards-only snapshot has its own
`frozen-guards.json` digest and transformation record; both pins are checked
before and after every acceptance run.

## Frozen pre-change state

Before product edits, `baseline.mjs` captured exact mutation and confirmation
JSON, collector inputs, legacy counters, logs, and a SHA-256/source copy of all
16 mutation modules under `.scratch/s17/baseline-node26/` and
`.scratch/s17/baseline-node22/`. The old runtime at
`.scratch/s17/old-runtime/packages/cupel/` uses that mutation source copy and
the pre-edit engine/collector/schema files. It is never rewritten for a new
candidate. Current source hashes are checked at the start and end of each
comparison.

## Workloads and gates

- Existing node:test mutation fixture: four tests, two source files, six drawn
  mutants and one survivor recheck.
- Existing pinned Jest conformance fixture: two test files, eight tests, two
  drawn mutants. The fixture is copied into scratch with its already installed
  project-owned `node_modules` linked; no dependencies are downloaded.
- Explicitly synthetic source-heavy fixture: a generated 703-line/20,125-byte
  lookup module with three real node:test cases. Its input is collected with
  two actual `collectNode` runs. No sleeps or artificial waits are used.

`compare.mjs check` compares the entire mutation and confirmation objects,
drawn mutant counts, and all legacy counters to the pre-edit baseline where it
exists. Run this on Node 22.23.3 and 26.7.0. `diagnostic.mjs` makes separate
instrumented runs and counts mutator-launched child processes and explicit
project-source reads; those runs are
excluded from warm timing. New optional source-fact counters distinguish source
reads/bytes, lexing, validity checks, and retained payload. The 32 MiB cap
applies only to accounted retained source-fact payload, not process RSS.

`compare.mjs timing` makes one warmup per method followed by five sequential
alternating triplets per workload on Node 26.7.0. Reversing each triplet gives
five old/guards and five guards/current paired comparisons. Each invocation starts a fresh
parent process, executes the complete mutation and survivor confirmation, and
reports process invocation wall time, mutation wall time, parent CPU, parent
max RSS and after-GC retained heap. RSS and parent CPU exclude child process
totals; there is no invented process-memory pass threshold. Inputs and the
project files remain fixed across pairs. A mismatch or runtime error stops the
run; there is no fallback to a different fixture or runner.

## Commands after the product source freezes

```sh
node plans/spikes/s17/prepare.mjs /Users/vid/cupel/.scratch/s17/measure-final-node26
/opt/homebrew/opt/node@22/bin/node plans/spikes/s17/prepare.mjs /Users/vid/cupel/.scratch/s17/measure-final-node22
node plans/spikes/s17/compare.mjs check /Users/vid/cupel/.scratch/s17/measure-final-node26
/opt/homebrew/opt/node@22/bin/node plans/spikes/s17/compare.mjs check /Users/vid/cupel/.scratch/s17/measure-final-node22
node plans/spikes/s17/diagnostic.mjs /Users/vid/cupel/.scratch/s17/measure-final-node26
node plans/spikes/s17/compare.mjs timing /Users/vid/cupel/.scratch/s17/measure-final-node26
```

The baseline, prepared inputs, full diagnostic outputs, and paired timing JSON
stay ignored under `.scratch/s17/`. Source-heavy results are synthetic evidence;
the existing Jest and node:test fixtures are separately reported. Collection
and baseline preparation time are recorded separately from each mutation
request. No release or real-repository performance claim follows from these
fixtures alone.
