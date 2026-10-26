# S16 cohesive request results

Date: 2026-10-25. Verdict: **the cohesive coordinator is faster than the old
selected API on both real faults, but remains slower than a complete
privacy-guarded full run**. This does not justify shipping selective PR mode.

## Identity and safety

The frozen trusted S12b reference hash is
`sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b`.
The S16 composite producer hash, including its coordinator, hook and
transitive engine/analysis/schema source, is
`sha256:83e34e949d9a178b1dbb0e2b97d7de8eade65f9297466297a9aa88a634cae29a`.
The expected hash is required inside every candidate request and checked
before any selected process and after execution. An external full-descriptor
check ran once at preparation; warm request time includes the internal hash
proof. The owner-approved `express-root-npmrc-opaque-v1` policy was explicit
for baseline, heads and guarded full reference. No root `.npmrc` bytes were
read or hashed.

A **fresh** baseline was captured from the pinned public Express commit
`4ca3fa8701629a4eb27c76a69aa6d6e294290b40`; the historical S12b bundle
was not reused. Its 65 test IDs/statuses matched Cupel's actual collector and
the ordinary/constrained full profile. Both fault heads kept the original
four-file lane, had complete privacy-guard traces and exact full parity, and
changed only their intended source. Selected requests ran no full oracle
inside the call.

| Real source fault | Full failures | Old selected | Cohesive selected | Result |
|---|---:|---:|---:|---|
| Accessible tables | 4/65 | 2 files, 31 tests | 2 files, 31 tests | All 4 failures caught; exact rows |
| Code tabs | 8/65 | 1 file, 18 tests | 1 file, 18 tests | All 8 failures caught; exact rows |

Four **fresh** 15-case matrices passed: Node 22.23.3 and 26.7.0 under both
`strict-v1` and the opaque policy. Each had 10 ordinary full-oracle faults,
8 selected cases with exact old/cohesive decisions and selected rows, 1
logged D16 full route and 6 refusals. Seven changed-code cases were strict
subsets; the source-text pin selected 4/8 files and failed. There were no
false greens. Full/refusal routes did not execute a selected fallback. Raw
matrix roots are `.scratch/s16/oracle/a1` through `a4`; each has a summary and
case evidence. The final producer's targeted Node 22/26 tests passed 22/22.

## Diagnostic counts, separate from warm timings

The public checkout's safe input inventory has **964 files and 8,559,996
bytes** (8.16 MiB), excluding `.npmrc`, Git internals and installed package
trees. The two heads retain 964 files, with 8,560,000 and 8,559,984 bytes.
These are metadata sizes of unique files. Parent filesystem counters below
count repeated reads and returned bytes, so they are larger than the unique
inventory.

| Case/method | Directory scans | Metadata calls | File reads | Base bytes returned | Head bytes returned | Trusted source bytes returned | Child wall sum |
|---|---:|---:|---:|---:|---:|---:|---:|
| Accessible, old | 1,471 | 18,424 | 5,937 | 9.09 MB | 44.96 MB | 0.19 MB | 151 ms |
| Accessible, cohesive | 736 | 10,184 | 3,074 | 9.09 MB | 18.21 MB | 0.51 MB | 156 ms |
| Code tabs, old | 1,471 | 18,355 | 5,916 | 9.09 MB | 44.88 MB | 0.19 MB | 75 ms |
| Code tabs, cohesive | 736 | 10,183 | 3,073 | 9.09 MB | 18.21 MB | 0.51 MB | 72 ms |

The cohesive request reports **1 baseline input snapshot, 2 head input
snapshots and 2 or 1 selected processes**. It reduced repeated scan/read
work, while its composite source proof read more trusted source bytes. The
old/cohesive traces had identical sizes: 19,931 bytes for accessible tables
and 3,440 for code tabs. Lockfile reads fell from 11 to 6; observed package
file reads fell from 78 to 50 for accessible tables and 58 to 50 for code
tabs. The preload stored no file paths or contents and recorded zero opaque
read attempts or unattributed file-descriptor reads.

Instrumented diagnostic method wall/parent CPU were 538/460 ms (old) versus
396/270 ms (cohesive) for accessible tables; 453/450 versus 314/271 ms for
code tabs. Guarded full was 133 ms wall with only 2–3 ms **parent** CPU because
the tests ran in child processes. Parent RSS is recorded as raw
`process.resourceUsage().maxRSS` values, and `/usr/bin/time -l` output is
preserved verbatim; neither is treated as total child memory or a speed
result. Diagnostic counters and raw resource output are in the separately
instrumented `.scratch/s16/express-83e34e-diagnostic-v2/`. Its preparation
files are byte-for-byte copies of the sealed fresh baseline evidence.

## Uninstrumented warm wall time

On local macOS arm64 with Node 26.7.0, one warm-up per method and fault was
logged. Each comparison then used five alternating pairs on a quiet host.
The whole selected request includes producer pin, baseline validation, head
inventory/lock/dependency checks, decision, selected test processes and
post-run trace validation. Guarded full includes its privacy preload and
complete guard-trace inspection. Paired calls use the same 65-test universe
and fixed environment. Raw sealed results are in
`.scratch/s16/express-83e34e-final-a/`.

| Fault | Old selected, ms | Cohesive selected, ms | Medians and optimization gate |
|---|---:|---:|---|
| Accessible tables | 405, 400, 416, 419, 423 | 318, 319, 313, 316, 328 | 416 vs 318 ms; 23.6% lower, 5/5 wins |
| Code tabs | 331, 338, 334, 325, 329 | 249, 249, 241, 247, 241 | 331 vs 247 ms; 25.4% lower, 5/5 wins |

| Fault | Cohesive selected, ms | Guarded full, ms | Medians and usefulness gate |
|---|---:|---:|---|
| Accessible tables | 329, 324, 317, 334, 329 | 132, 132, 128, 135, 131 | 329 vs 132 ms; 0/5 wins |
| Code tabs | 246, 242, 245, 245, 244 | 132, 131, 134, 132, 133 | 245 vs 132 ms; 0/5 wins |

The defined optimization gate (at least 20% median improvement and 4/5 paired
wins for both faults) **passes**. The production usefulness gate (4/5 wins
and at least 10 ms median gain over guarded full for both) **fails**.

Median cohesive internal phases were roughly 53 ms baseline validation, 44
ms head preflight, 154 ms two-file capture and 45 ms post validation in the
accessible case; 55, 46, 74 and 47 ms in the code-tabs case. The selected
Node process wall sums were 153 and 74 ms. The old capture included about 92
ms beyond those process times; cohesive capture reduced that overhead to
about 1 ms. The remaining validation work and serial selected processes keep
whole-call time above full execution. In the two-file case, the **153 ms
process sum alone** exceeds the 132 ms full median. Rust or caching may
change validation costs, but this evidence does not show a Rust speed gain or
establish that validation changes alone can satisfy the full-run gate.

The fresh preparation command took 3.63 s tool wall, including baseline and
both fault full profiles plus initial old/cohesive selections; it is excluded
from warm pairs. Its three ordinary full subruns were 131, 131 and 136 ms,
and constrained child sums were 353, 353 and 362 ms. The preparation command
was not instrumented into exact per-stage wall spans, so these subruns are
components, not a complete baseline-capture wall estimate. OS caches were
already warm; no cold-cache latency claim is made.

## Decision and next action

Keep selective PR mode experimental. The next best action is to decide whether
another bounded redesign can reduce whole-call proof work and the serial
selected-process cost while preserving exact source/policy binding, complete
head snapshots, opaque privacy, and fresh test outcomes. Reusing verified
parsed facts within one request is plausible; reusing old head test outcomes
or silently rebuilding on missing/corrupt evidence is not supported. No
production PR/CLI/MCP selection was added in S16.
