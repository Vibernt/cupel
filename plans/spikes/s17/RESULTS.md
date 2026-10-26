# S17 source analysis reuse: measured result (2026-10-25)

## Method and identity

The pre-change source copy and full mutation/confirmation JSON were captured
before product edits on Node 22.23.3 and 26.7.0 at ignored
`.scratch/s17/baseline-node{22,26}/`. The legacy mutation tree has 16 files,
hash `sha256:ca1116b2501b4855f61e673b5a2b233dbeadbb7f33ff03a798628966afebf67e`.
The repaired product tree has 19 files, independently recomputed hash
`sha256:9e24423e3e5f3674d5608dcd7b84d31bf278b26e16bb79820b6e9caf9b12646f`.
An ignored guards-only runtime keeps the repaired path and freshness checks but
restores the old lex/site path and rereads mutant text. Its separately pinned
source hash is
`sha256:a1ea90eafa525a45eff14a7e34cb83788edab0f7061f42b1ea223ece1271d463`;
the exact scratch-only transformations are in
`.scratch/s17/guards-only-runtime/transform.json`. The earlier changed tree
`53a8f654…` was revoked after a pre-read path/privacy issue; its checks and
diagnostics are retained only as historical evidence and it was never timed.

Three workloads kept their whole test inventory and configured mutation work:

| Workload | Evidence | Tests | Mutants | Survivor rechecks |
| --- | --- | ---: | ---: | ---: |
| Existing node:test mutation fixture | Repository fixture copy | 4 | 6 | 1 |
| Existing pinned Jest conformance fixture | Repository fixture copy, installed Jest 30.2.0 | 8 | 2 | 0 |
| Generated source-heavy lookup | **Synthetic**, 703 lines / 20,125 bytes; actual two-run node:test collection | 3 | 8 | 3 |

On both Node 22 and 26, all three methods produced **exactly equal full
mutation and survivor-confirmation JSON**, including mutant IDs/statuses,
killers and targeted IDs. Legacy counters and test counts matched for every
workload. The saved pre-edit node:test and Jest outputs matched the frozen
legacy runtime byte-for-byte. Raw checks are in
`.scratch/s17/approved9e-node{22,26}/check.json`. Product-focused Node 22
21/21 plus 10/10 path controls passed; Node 26 actual Jest and Vitest 4.1.11
mutation controls passed. The measurement harness has 10/10 local tests on both
Node runtimes. Its separate descriptor-read diagnostic test also passed.

## Actual work and freshness cost

Diagnostic-only instrumentation, excluded from warm timing, counted parent
source reads and mutator-launched fresh test processes. Reads include file
descriptors opened by the repaired path guard. Node 26 raw evidence is
`.scratch/s17/approved9e-node26/diagnostic.json`.

| Workload | Legacy source reads | Guards only | Guards + reuse | Fresh runner launches, every method | Retained source facts |
| --- | ---: | ---: | ---: | ---: | ---: |
| node:test | 8 | 49 | 49 | 10 node:test | 144 bytes |
| Jest | 3 | 15 | 15 | 4 Jest | 76 bytes |
| Synthetic heavy | 10 | 75 | 75 | 16 node:test | 20,125 bytes |

At `jobs:1`, each mutant is built in its own batch, so retained text saves no
source reads. The guards deliberately reread/hash current bytes before and
after test execution and at confirmation boundaries; they account for the
increase over legacy. They were retained for safety. The same-guard product
path does reuse accepted lexical facts: its mutation fact hits were 6, 2 and 8
for the three workloads, while the guards-only control had zero fact hits.
Validity-worker launch counts were unchanged at 7, 3 and 9.

A separate bounded `jobs:2` diagnostic from the product worker used the same
guard/current source pins and exact output/runner-count parity on both Node
runtimes. Mutation source reads fell **29→26** for node:test, **13→12** for Jest,
and **37→33** for the synthetic source-heavy case; confirmation reads remained
14/14 for node:test and 30/30 for source-heavy. This demonstrates 1–4 fewer
reads from per-batch text reuse when a batch contains multiple mutants. It is
an instrumented read-count result, **not a latency claim**. Raw evidence is at
`.scratch/s17/jobs2-0sw9v7p3/diagnostic.json`.

The retained source-fact payload was below the **32 MiB accounted payload
cap** on these cases. That cap is not a process RSS or heap limit. SourceFacts
binds one mutation/confirmation request to current raw source bytes, logical
and real path, device and inode, optional canonical declared source hash, and
request-issued facts. It does **not** compute parser, Node runtime, config or
schema identity hashes. Those remain separate request/module context. Opaque
supplied source hashes, unsafe or hard-linked source paths, and hosts without
`O_NOFOLLOW` refuse rather than silently weakening the read boundary. A
source drift observed at those fresh-check boundaries refuses; results and test
outcomes are never cached.

## Five alternating whole-mutation triplets

Node 26.7.0, Darwin arm64. One untimed warmup per method preceded five
sequential reversed triplets. Each sample started a fresh parent process and
included full mutation, actual test file execution, syntax validity and
survivor confirmation. Inputs/project bytes and all three source pins were
checked before and after. No diagnostic preload ran during timing. Raw per-call
wall/parent CPU/RSS/after-GC retained heap are in
`.scratch/s17/approved9e-node26/timing.json`.

| Workload | Legacy median | Guards-only median | Guards+reuse median | Reuse faster than same guards |
| --- | ---: | ---: | ---: | ---: |
| Existing node:test | 818.93 ms | 820.12 ms | 825.04 ms | 0/5 |
| Existing Jest | 2104.13 ms | 2113.90 ms | 2119.53 ms | 2/5 |
| Synthetic heavy | 1271.84 ms | 1271.81 ms | 1264.44 ms | 4/5, 7.36 ms lower median |

The guards-only versus legacy comparison captures the stronger safety checks
*and* its supporting refactor; it is not a pure cost of any individual guard.
The same-guard comparison isolates lexical and batch text reuse. The only
observed median gain was on the labeled synthetic source-heavy case, under 1%
of whole-request wall. Existing node:test and Jest cases did not get faster.
Parent CPU user median (legacy/guards/reuse) was 19.7/26.2/26.1 ms for
node:test, 61.1/65.0/66.4 ms for Jest, and 161.7/192.9/171.0 ms for the
synthetic case. Parent max RSS median was 58,816/63,152/62,848 KiB,
86,608/89,696/87,056 KiB, and 86,464/88,688/82,064 KiB respectively.
These are parent-process measurements; they are not summed child memory and
do not imply throughput or a memory-cap pass. The raw artifact also records
after-GC retained heap and all five paired values.

## Verdict and next action

The repaired source-path and freshness protections should be evaluated as a
**safety correction**, independently of legacy latency. The source-fact reuse
preserves exact behavior and, at `jobs:2`, removes a few source reads without
removing any fresh test execution. The three measured whole-request workloads
do **not** support a general speedup claim. Keep the safety checks; use the
same-guard results when describing performance. The next useful action is to
finish the full correctness gates and adopt the safety correction, then profile
repeated coverage parsing in `Session.select` before one bounded cache change.
The present S17 data already rejects a general speed claim; no new external
benchmark round is implied.

No external repository acceptance, package publication, or production release
was exercised by this spike. The synthetic case is a scale probe only.
