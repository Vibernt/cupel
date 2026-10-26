# S18 real lane measurement (2026-10-25)

## Method and evidence

The unchanged public Express unit lane at commit
`4ca3fa8701629a4eb27c76a69aa6d6e294290b40` has four test files and
65 tests. Git commit and tracked `.npmrc` index entry were verified with
metadata-only commands. The explicit `express-root-npmrc-opaque-v1` policy
excluded that root file's bytes from the input hash and guarded both ordinary
full runs and selected runs against reading it. The existing collector input
was reused and hash-checked; its 125,125 bytes have SHA-256
`de0915855549d16d31251d4a313b8fcb70603625a2903a44b39aeedd4446bce2`.
Its original collection time was **not measured in S18**.

The S16 producer pin was
`sha256:83e34e949d9a178b1dbb0e2b97d7de8eade65f9297466297a9aa88a634cae29a`;
the S18 producer pin was
`sha256:797e69818bf163cc661fd659ae633cb82549660d200a0fff9a4e8f0f865ecdfe`.
Preparation produced a 262,024-byte private sealed artifact with independently
recorded raw hash
`sha256:050dec494324184961f37dd758677c9e18ed3e9533f23ba682d31557fbbbe497`.
The benchmark's artifact pin is local experiment evidence, **not a production
authenticity service**. S18 consume did not receive or read the baseline root.

Node 26.7.0 on Darwin arm64 ran one warmup per method and fault, followed by
five sequential alternating pairs of complete S16/S18 API calls and five
S18/privacy-guarded ordinary full pairs. Every selected call verified the
same exact selected files and test ID/status rows as the full oracle. The
`accessible` fault failed 4 full tests and selected 2/4 files (31 selected
rows); `code-tabs` failed 8 and selected 1/4 files. Every S18 call reported
one artifact read, one current HEAD test-universe walk, two fresh HEAD input
snapshots, the actual selected process count, and zero baseline-root reads.
There was no hidden full run in S18 consume. Complete per-call records and the
summary are under `.scratch/s18/measure-real/a1/`; the independent four-mode
Node 22/26 × strict/opaque safety matrices are in
[`../MATRIX-RESULTS.md`](../MATRIX-RESULTS.md).

## Whole-call wall time

Medians are milliseconds. The two comparison columns come from separate sets
of five paired calls, so their S18 medians can differ. The guarded full
reference includes its privacy guard and all four test files.

| Real fault | S16 in S16/S18 pair | S18 in S16/S18 pair | S18 faster than S16 | S18 in S18/full pair | Guarded full | S18 faster than full |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Accessible tables | 338.67 | 287.07 | 5/5; 51.60 ms median | 288.99 | 136 | 0/5 |
| Code tabs | 250.45 | 208.68 | 5/5; 41.77 ms median | 208.95 | 137 | 0/5 |

Relative to S16, S18's paired medians were 15.2% and 16.7% lower. Relative
to executing this fast complete unit lane, S18 still cost about 153 ms and
72 ms more per repeated request at the respective paired medians. A strict
subset of files and fewer child tests therefore did **not** translate into a
useful latency result for this lane. These are latency observations, not
throughput or general runtime claims.

The S18 internal phase medians across the ten calls per fault were approximately
35–36 ms sealed verification, 45–46 ms fresh HEAD preflight, 160/77 ms
selected capture, and 47–49 ms postflight for accessible/code-tabs. The
capture child-time sums were 159/77 ms; all other process setup and validation
remained in the measured whole API. S16's baseline-validation phase medians
were 58/56 ms. The full end-to-end difference cannot be assigned solely to
that phase because coordinator/proof work outside these labels also differs.

## One-time work and repeated artifact cost

On this run, independent producer-pin verification took 4.10 ms, checking the
**saved** collector input and public Git metadata took 82.28 ms, and the
actual `prepareSealedBaseline` call took 911.72 ms. The measured/accounted
fixed work was **998.10 ms**, before any request. This does not include the
unavailable original collector-generation cost, dependency test setup, or the
separate fault full-oracle runs used to validate the experiment. It is not a
complete cold-start preparation figure. The S16 context load used only by
the comparison harness took another 74.36 ms and is excluded from S18 setup.

Five diagnostic-only reads of the 262,024-byte artifact gave medians of
0.039 ms raw read, 0.110 ms SHA-256, 0.437 ms JSON parse and 0.550 ms for the
`readArtifact` method including its checks. Those are component diagnostics;
whole S18 calls include much more validation. No artifact work was excluded
from the warm whole-call samples.

If the same accounted 998.10 ms setup is spread over hypothetical repeated
requests with the observed S18/full-pair median, the arithmetic per-request
costs are:

| Real fault | 1 request | 10 requests | 100 requests | Guarded full median |
| --- | ---: | ---: | ---: | ---: |
| Accessible tables | 1287.09 ms | 388.80 ms | 298.97 ms | 136 ms |
| Code tabs | 1207.05 ms | 308.76 ms | 218.93 ms | 137 ms |

This is an amortization calculation over measured components, not a measured
multi-request throughput rate. The missing collector prerequisite would raise
these totals. Even ignoring that prerequisite, they remain slower than full
execution in this lane. Total memory and throughput were not measured in S18;
neither can be inferred from the latency samples.

## Verdict and next action

The sealed baseline removes repeated baseline checkout reads while preserving
the tested selection and refusal behavior. It improves S16 in both real
faults, but the guarded full lane wins all ten paired comparisons. S18 is
**not justified as a latency optimization for this real lane**. Keep it an
experimental option and do not promote selective PR mode on these numbers.
Its producer and artifact pins still require an independently trusted owner
workflow; local hash agreement alone does not authenticate history.

Next best action: finish the full correctness gates, adopt the S17 source-path
safety correction if they pass, then profile `Session.select`'s repeated
coverage parsing before one bounded cache change. The S18 result itself does
not call for another external benchmark round.
