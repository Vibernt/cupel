# S16 cohesive request measurement

Status: **safety proved for the bounded matrices and real faults; cohesive
request optimization passed, guarded-full usefulness failed**. Detailed
numbers are in [RESULTS.md](RESULTS.md). This is an experimental comparison,
with no production PR command change.

## Fixed lane and trust boundary

- Public Express commit `4ca3fa8701629a4eb27c76a69aa6d6e294290b40`;
  unchanged four-file `test:unit` lane, 65 tests, Node 26.7.0 on local macOS
  arm64. Two isolated source faults fail 4 and 8 complete-oracle tests.
- Explicit `express-root-npmrc-opaque-v1` for baseline, both heads and guarded
  full reference. The tracked root `.npmrc` is metadata-bound, never read or
  hashed. Git pin checks use only `rev-parse HEAD` and `ls-files --stage --
  .npmrc`; no status/diff/index refresh.
- Generate a **fresh** S12b frozen-profile baseline and both complete fault
  oracles. Revalidate exact IDs/statuses, collector parity, guard completion,
  privacy denials, and the one changed source. Seal bundle and oracle files
  with hashes; missing or changed files refuse. The old S12b raw bundle is not
  used as S16 proof.
- Candidate requests require the exact frozen producer descriptor/hash before
  any selected process. The request also checks its own source before and
  after execution. Selected rows must equal the corresponding full-oracle
  rows and include every full failure. Old and candidate selections must
  match exactly. No unsupported or incomplete trace is accepted.
- Four synthetic matrices (Node 22.23.3 and 26.7.0, strict and opaque) and
  source-text controls must pass before an S16 speed claim. Express is run
  only on Node 26 because its package metadata requires Node >=24.15.

## Measurement decisions

1. Record baseline collection and both full fault-profile validity captures
   as setup/proof cost, outside warm request pairs.
2. Run separate diagnostics for old selected, cohesive candidate and guarded
   full, per fault. A diagnostic-only preload counts parent filesystem calls
   and returned bytes by aggregate bucket. It refuses an attempted `.npmrc`
   content read and records no path or content. Candidate counters record
   baseline/head snapshot passes and selected process count. Trace bytes come
   from file metadata; child wall times come from capture records. Parent
   CPU and RSS from Node and raw `/usr/bin/time -l` output are kept separate,
   with no claim that parent RSS is total child memory.
3. Wait for all control matrices and other host tests to finish. Log one
   warm-up per method and fault. Then run five alternating pairs of old versus
   candidate and five alternating pairs of candidate versus privacy-guarded
   full, for **each** fault. Warm pairs run without the diagnostic preload.
   Whole-call selected time includes selection, inventory/policy, capture and
   post-run validation. The full reference includes its privacy guard and
   complete trace inspection. The candidate whole-call gate includes the
   mandatory frozen-producer hash comparison and its internal recomputation.
   The acceptance harness checks the complete descriptor once during setup.
4. An optimization finding needs candidate median at least 20% below old and
   candidate faster in at least four of five pairs **for both faults**. A
   useful selective mode additionally needs candidate faster than guarded
   full in at least four of five pairs and at least 10 ms median gain **for
   both faults**. Safety failure blocks any performance conclusion.

The old and candidate hooks run selected files in separate serial Node
processes. A faster inventory/validation implementation alone cannot be
assumed to shorten test process time. The diagnostic counts identify repeated
work that might support verified reuse; they do not authorize a cache miss
fallback or reuse of fresh head test outcomes. No cold OS-cache claim is made
from warm process runs.

## Test coverage

The local oracle, paired schedule, sealed artifact, opaque diagnostic and
producer-pin negative tests are in this directory. Fresh real end-to-end
captures, four 15-case matrices and paired warm runs are recorded in
[RESULTS.md](RESULTS.md).
