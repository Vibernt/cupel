# Cupel performance flow and reuse contract

Owner direction, 2026-10-25: rethink flow/orchestration/caching/reuse to improve
Cupel generally. Astra planned the stages below; S16 implements the first two
bounded slices and explicit report-only MCP snapshot replay. General input/model
snapshot reuse and disk caches remain planned. This does not authorize weakening
guards or a blanket Rust port.

## Target execution graph

Resolve root, schema, config and runner once → source facts → fresh collection
runs → immutable evidence → minimal mutation index/site plan → fresh baseline,
mutant and required confirmation jobs → new evidence revision → pure views.

Guard prepares trusted base and current head separately, preserves required
test/mutation freshness, and performs the minimal protection comparison. Report,
review, plan, label and MCP pages consume named immutable evidence plus prepared
analysis rather than implicitly repeating earlier execution.

## Reuse boundaries

| Data | Safe lifetime / key | Required freshness |
| --- | --- | --- |
| Root, effective config, schemas | One unchanged request/config snapshot | Reject config/schema identity drift |
| Source parse, lexical tokens, line maps, mutation sites | Exact bytes + path/language/parser/runtime/transform/detector identities | Recheck bytes after executed-test phases; timestamps alone are insufficient |
| Coverage interval/model analysis | Immutable input bytes + config/schema/engine hashes | New evidence revision produces a new analysis identity |
| Prepared runner configuration | One bounded mutation session | Await initialization and drain failures before cleanup |
| Test status, per-run coverage/counts, duration, mutation kills, instability and rechecks | Fresh for each required execution ordinal | Never reuse as a current live outcome implicitly |
| Saved baseline or report input | Explicit named historical evidence | Validate identity and provenance; replay is not proof that HEAD just ran |
| MCP view/page | Explicit immutable evidence handle/input hash | Zero collection or mutation jobs for later pages of that snapshot |

## Priority order

1. **Within-request orchestration.** S16 shares one pre and one fresh post view;
   baseline verification remains. Remove duplicate work before changing language.
2. **Pure engine views.** Guard/validate omit unused advice; consolidate by
   relevant buckets; reuse duplicate/file indexes within one immutable model.
   Compare complete reports and exits, including diagnostic order.
3. **Source facts per request.** Reuse lexical/line/site work across the mutation
   batch; bound retained data (proposed 32 MiB) and do not retain every mutant
   text. Read current bytes across execution boundaries before reuse.
   The owner explicitly prioritized this next; [S17](spikes/S17.md) records the
   bounded implementation, freshness checks and whole-mutation measurements.
4. **Explicit MCP evidence snapshots.** First live capture creates a versioned,
   content-addressed local artifact; later pages/report/review/plan name it.
   No handle means fresh execution as today. Responses identify the evidence
   revision and replay status; guard never infers a fresh pass from a view.
   The implemented first slice caches only completed **report output** in one
   server process (`retain` / `snapshotId`); it pages that historical report
   without CLI/collection/mutation calls. It is not a raw-input cache for guard
   or the other analysis tools. It retains at most 8 entries / 32 MiB and errors
   explicitly on missing/evicted/corrupt snapshots. See [S16](spikes/S16.md).
5. **Persistent static analysis, after measurement.** Host-side cache envelopes
   bind source digest, path, language, parser/engine, runtime, transform, config,
   schema and payload hash. Do not persist raw source or secret/environment
   values. Atomic writes and a bounded size (proposed 256 MiB) are required.
   Explicit policies: `off`, `populate`, `read`; `read` requires an exact hit or
   returns a named missing/stale/corrupt error. It never silently recaptures.
6. **Parse-only workers.** One bounded syntax-validation worker per mutation
   session can replace repeated worker startup. It never executes target code.
   Versioned request IDs, timeouts, drain-on-error and explicit close are required.
7. **Independent scheduling.** Measure bounded parallel execution of existing
   isolated jobs separately. Preserve process boundaries, ownership, repeats,
   confirmations and budgets. Base/head parallelism needs independent roots,
   outputs and dependency preparation; do not assume arbitrary tests are pure.

## Cache and proof tests

Check same-size/same-mtime byte changes, renamed paths, config/schema/parser/
runtime/transform drift, missing/corrupt/truncated payloads, cross-root use,
environment-sensitive misuse, mutated caller objects, context replay, concurrent
writes, eviction and required-hit misses. Preserve malformed-input, unknown-tag,
runtime and identity guardrails. Identity hashes establish identity, not trust;
CI baseline storage remains outside the proposing agent's write scope.

Counters must demonstrate the intended avoided work: guard advice calls zero,
consolidation comparisons limited to within-bucket pairs, source analysis once
per unchanged phase, page-two test/mutation starts zero, syntax workers at most
one per session, and unchanged required collection/recheck counts.

## Rust decision

Owner direction: skip a Rust port unless measurements establish a worthwhile
benefit. No port or new Rust dependency is scheduled. Source reuse and incremental
selection using a pinned historical baseline ([S18](spikes/S18.md)) take priority.

Rust is a candidate for a remaining measured compute-heavy leaf: interval and
set processing, coverage parsing or source mapping. Source inspection alone does
not establish that these dominate Cupel wall time. Require CPU profiling, exact
semantics, a substantial share of whole-call cost (proposed at least 30%), and
measured gain including binary/Wasm setup, data copying, serialization, identity
validation and distribution cost. Keep the pure engine portable to Workers; an
optional native-only rewrite is not a substitute for that contract.

Report latency, throughput, baseline/setup/cache populate versus read cost, and
memory separately. No memory reduction is called a speedup. No fixed speedup is
promised before equivalent complete operations have been measured.

## Additional reuse audit, 2026-10-25

The owner requested more reuse and incremental opportunities. The following
findings come from current source inspection. They are implementation candidates,
not measured speedups. Finish the S17/S18 gates before expanding product scope.

| Priority | Repeated work / source | Proposed reuse and invalidation | Acceptance / decision |
| --- | --- | --- | --- |
| Measured prototype: S18 | S16 verifies a saved baseline against its checkout and dependencies on every request; the earlier diagnostic baseline stage was about 53 ms | Prepare a versioned historical artifact once; consume only with an independently trusted raw-byte hash, commit and producer pin. Current HEAD pre/post reads and fresh execution remain | Zero baseline reads in all 60 matrix consumes; repeated selection medians fell 338.67→287.07 and 250.45→208.68 ms. Full still won at 136/137 ms. Preparation and amortization are in [S18 results](spikes/s18/measure/RESULTS.md); no production promotion |
| Accepted: S17 | Operator/body enumeration duplicates lexer/bracket work; drawn mutants reread the same source within one synchronous batch | Request-owned exact-byte source facts; shared compatible token streams and one text view per source per batch; explicit 32 MiB payload cap | Three-way measurement showed no general whole-call speedup. Two-job diagnostics saved 1–4 reads with the same new guards. Adopted as a correctness improvement after full runtime/installed gates; [S17 results](spikes/s17/RESULTS.md) |
| Profiled, deferred: mutation coverage | `mutate/index.mjs` `Session.select` reparses `model.byTest`, `setup` and `byFile` line strings for every mutant | A session-local parsed coverage index remains possible, but is not implemented | [S19](spikes/S19.md): complete default-jobs Node/Jest/source-heavy requests on Node 22/26 spent only about 0.02–0.19 ms in repeated parsing, under 0.04% of request wall. Entire selection was below 1 ms. The 10 ms / 5% implementation gate failed |
| Next profile: sealed selection index | `s16/selection.mjs` `covered` scans all test rows for each changed source and owner; dependency arrays are searched repeatedly | Derive source-to-owner and application-observer indexes from the exact validated baseline artifact within the consume request. A persistent derived index would also bind artifact, schema and producer hashes | Keep refusal reasons, critical/new tests, directory dependencies and D16 routes exact. Measure first: the present 65-row selection decision is small |
| Low-cost candidate: assertion analysis | `engine/index.mjs` validates review assertions by analysing them, then `engine/review.mjs` analyses the same sidecar again | Hand the successful request-local analysis into review rendering; malformed sidecars still stop at the existing validation point. No cross-request state | Complete valid/invalid single/multi-runner review output and diagnostic parity; count one analysis per review. Measure large sidecars before claiming meaningful latency |
| Low-cost candidate: Node collector facts | `collect/node/index.mjs` has separate title and definition caches that can analyse the same defining file twice, with rechecks between phases | Share facts only after a fresh content check at the later phase. Key by exact file bytes/path and parser identity; no reuse across executed tests without verification | Parameterized/external test definitions, same-size source writes during rechecks, missing-definition diagnostics and exact shape/title/brittleness parity. Vitest and Jest already have per-file caches; do not count them as absent |
| Later: parsed engine input | `engine/integrity.mjs` parses coverable and coverage line sets, then `engine/model.mjs` parses the same accepted values | A private prepared-input object can carry validated interval maps into model construction in the same invocation; keep arrays isolated from mutating callers | Full report/exit/diagnostic ordering parity, malformed ranges and no input mutation. The real 65-row engine report is only about 7 ms, so this is not yet the main target |
| Later: producer proof reads | S18's producer proof computes the S16 proof and then reads overlapping source files for its own manifest | A private digest ledger may share bytes within one synchronous pre-proof or post-proof phase. Never reuse across selected test execution | Exact producer hashes/manifests and source-change negatives. Profile proof cost before changing the frozen closure |
| Later: retained historical analysis | S18 reconstructs and validates the same sealed historical baseline in each consume call | In a long-lived host only, a bounded private verified-baseline cache could bind artifact raw hash, trusted commit/producer pins, runtime and policy. Keep current artifact/producer/runtime checks and all HEAD work fresh; no caller-supplied validated flag | Profile first: artifact read/hash/parse costs only about 0.55 ms here; the roughly 35 ms sealed phase also includes other mandatory work. One-shot CLI processes cannot reuse an in-memory cache. Require corruption/eviction/caller-mutation/drift negatives and include cache validation cost |

Existing reuse includes CLI schema loading, compiled glob patterns, per-session
baseline runs and file-duration indexes, lazy Jest configuration, Vitest/Jest
test-file analysis, S16 request phase views and report-only MCP snapshot paging.
Rebuilding a report model after mutation changes its input is necessary work.

For a future disk cache, separate content-addressed parsing from repository-bound
identity and dependency ownership. Identical bytes at different paths may share
syntax but must not share test/source identities. Cache reads require exact
source/config/runtime/schema/parser/producer and payload identities; a required
miss, corruption or stale entry is an explicit error. Do not memoize current test
passes, mutation kills, timeout probes, confirmation repeats or HEAD freshness.

S17's full runtime and installed-artifact acceptance passed. The independently
pinned S17 attribution and S18 whole-call experiments are complete. The owner
then authorized S19's conditional coverage-parsing profile. Its complete-workload
gate failed; no coverage cache or product change is justified by those results.
The saved 65-test input replay is scaling evidence only, not fresh outcomes or a
complete mutation speedup. The accepted private installation remains unchanged.
Rust remains deferred.

The conditional implementation decision below was planned by Astra and tested
in S19. Retain it for a future slow real workload rather than automatically
expanding the benchmark scope. First profile at its normal job setting, with
instrumentation excluded from any speedup claim. If selection
accounts for less than 10 ms or less than 5% of whole-request wall on every
measured workload, defer it. Otherwise add `mutate/selection.mjs`: snapshot the
relevant input fields, index only mutation-scope sources, parse each relevant
coverage entry once, and preserve row/file order, passed-only membership,
setup/by-file inclusion and targeted-unit full-run behavior. Return fresh
arrays/maps; retain no current execution result or cross-request state.

Tests must compare complete selection, mutation and confirmation results and
required execution counts across Node/Jest/Vitest, plus caller mutation and
setup/row/file coverage negatives. Five paired whole requests must include
index construction and retained-memory cost. Keep the implementation only if
it saves at least 10 ms median with at least 4/5 paired wins on the workload
that triggered it, without a greater than 5% median regression on the other
measured workloads. This is a future decision gate, not a measured result or
permission to weaken the completed S17/S18 acceptance contract.

Next best action: use the accepted private full-guard candidate. Reopen this
optimization only when a real slow mutation job supplies a materially different
whole-call profile. No additional cache implementation or research round is
scheduled from S19's failed trigger.
