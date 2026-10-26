# S18 sealed selection oracle matrix

Date: 2026-10-25. Experimental correctness evidence only; not a latency sample.
Producer pinned to
`sha256:797e69818bf163cc661fd659ae633cb82549660d200a0fff9a4e8f0f865ecdfe`.
The live S16 source proof remained
`sha256:83e34e949d9a178b1dbb0e2b97d7de8eade65f9297466297a9aa88a634cae29a`.

`matrix-run.mjs` made an actual Node baseline, ordinary full oracle and collector
input for each runtime/policy. It prepared one sealed artifact, then created all
15 original fixture heads and recorded each full oracle and old selected
decision/trace. It **removed the baseline path before any S18 consume call**.
Each consume used a literal producer pin, the sealed artifact's raw SHA-256,
and the saved commit identity. Stale and corrupt artifact cases altered the
saved proof, recomputed the raw digest for this adversarial validator test, and
required explicit refusal. The opaque `.npmrc` was a dummy descriptor; its
contents were never opened by the harness.

| Runtime | Policy | Raw summary | Artifact SHA-256 | Cases |
| --- | --- | --- | --- | ---: |
| Node 22.23.3 | strict | `.scratch/s18/oracle/m1/summary.json` | `24df922391278ed1582bd9630f1e0904c49a100413b2ddbcfbef90d93a69ab6a` | 15/15 |
| Node 22.23.3 | opaque | `.scratch/s18/oracle/m2/summary.json` | `af3c602fef8a3e7d76ab3a706c048557a48e534b0b1af642c64bb94d62e9592c` | 15/15 |
| Node 26.7.0 | strict | `.scratch/s18/oracle/m3/summary.json` | `8f13e63855f2b5b323145675549ac1b9f3c0e594a8dc5dabe85fa1817df43f82` | 15/15 |
| Node 26.7.0 | opaque | `.scratch/s18/oracle/m4/summary.json` | `5c740217f66a0d19248724b9d4262903f00666b59a941907408f5663cd9fb912` | 15/15 |

Each matrix had 10 full-oracle faults, 8 selected decisions, 1 D16 full route,
6 refusals, **8 strict subsets total (7 changed)**, and 5 changed-source strict subsets.
Every selected file list and exact ID/status row matched the old selected
capture and the corresponding full oracle. The source-text control selected
4 of 8 files and caught the fault. All 60 consume calls found the original
baseline path unavailable and reported zero baseline-root reads. No subset
was reported as a whole-suite guard pass. The D16 route did not run a hidden
full suite.

## Focused tests

`artifact.test.mjs` passed 2/2 and `request.test.mjs` passed 6/6 under the
Node 26 host; the same separate runs passed under the Node 22 host, for
**8/8 focused tests per host**. The request
tests execute both exact 22.23.3 and 26.7.0 child runners, including an
in-run source edit rejected by fresh postflight on each runtime. They also
cover absent baseline checkout, byte change with equal size and mtime, a new
test, D16 routing, opaque descriptor handling, installed dependency drift,
missing/truncated/malformed artifacts, wrong pins/runtime/policy, caller
context injection, symlink refusal, and rebound artifacts with `null`, empty,
or numeric per-file/global capability entries. Artifact tests cover protected
file shape, overwrite refusal, symlink refusal, and the 64 MiB read bound.

This proves the original fixture decision matrix under the four exact modes.
It does not establish a production speedup, cross-repository acceptance, or
authenticity of a caller-provided commit/hash pin. Whole-call latency and
trusted baseline storage are separate gates.
