# Private experimental selective PR checks

**Outside the supported first release.** These private experimental commands
remain available with their warnings and refusal paths. The [support
matrix](support.md) separates core full guard, bounded native preview and this
experimental capability; no promotion is implied by installed fixture evidence.

The source tree includes the opt-in `node-readonly-files-v2` profile for exact
Node **26.7.0**. It retains per-test V8 coverage, uses isolated whole test-file
processes and requires a sealed, complete baseline. Node 22 selective execution
refuses; ordinary collection and full guard continue to support Node 22.

This is a scoped check. Every result has `spec: "cupel-pr-result/1"`,
`wholeGuardPass: false`, and explicit executed and unexecuted file lists. Run
ordinary `cupel guard` when whole-suite protection approval is required. Correct
selection can take longer than full execution; no CI speed gain is promised.

## Trusted preparation

Preparation belongs in the trusted baseline workflow. Inspect the installed
producer with `cupel pr-producer --json`, approve it, and record its
`producerHash` outside the proposing agent's write scope. Preparation does not
choose a trusted pin for itself. The base must be an exact Git commit matching
the index and working tree, with the complete supported test inventory.

```sh
cupel pr-prepare --profile node-readonly-files-v2 \
  --base EXACT_COMMIT --producer-sha256 TRUSTED_PRODUCER_PIN \
  --work-dir /trusted/new-preparation-directory \
  --out /trusted/baseline.json --json
```

Use an actual Node 26.7.0 executable for Cupel, or pass its absolute canonical
path with `--node`. The output directories and artifact must be outside the
subject repository. Outputs are new paths: existing artifacts are never
overwritten. Retain the returned raw artifact SHA-256 independently of the
artifact. A digest proves byte identity; replacing both an artifact and its pin
does not make it trusted.

Preparation runs two full profile passes and two read-only normal-runner
reference passes, reconciles test rows, and executes exhaustive critical
mutation within configured caps. Missing parity, mutation evidence or a required
confirmation refuses preparation. Installed producer changes require a newly
trusted baseline; historical experimental S18 artifacts are incompatible.

## Execute a request

The current checkout must be a clean committed descendant of the baseline.
Configuration comes from the sealed baseline and must match declared tracked
`cupel.json`. A changed configuration or dependency installation refuses.

```sh
cupel pr --profile node-readonly-files-v2 \
  --base EXACT_BASE_COMMIT --producer-sha256 TRUSTED_PRODUCER_PIN \
  --baseline /trusted/baseline.json --baseline-sha256 TRUSTED_BASELINE_PIN \
  --work-dir /private/new-request-directory \
  --out /private/request-result.json --json
```

The selector includes critical files, new and changed test files, proven source
owners and conservative filesystem observers. Non-code changes take the
declared `profile-full` route and report its reason. Unsupported changed code
or missing dependency evidence refuses. Historical passing rows are never
inserted as fresh results for unexecuted files.

Compatible scoped baseline kills are compared with fresh HEAD mutation, and
survivors receive two confirmations. Changed critical source lines are verified
against exact base and HEAD bytes. Disappeared required baseline evidence
cannot count as an improvement. The result records mutation scope, exclusions,
comparison and whole-request costs separately from preparation costs.

Edited critical tests additionally retain their own compatible line and kill
evidence on unchanged sources. This check-like comparison is stronger than
ordinary full guard's aggregate protection comparison. A different test retaining
the same aggregate kill does not erase that edited critical test's lost evidence.

Exit codes are **0** for completed scoped success, **1** for executed failure or
scoped protection regression, **2** for invalid invocation, and **3** for
unsupported, stale, refused or incomplete evidence. Exit 0 is never a
whole-suite guard approval.

## Experimental profile boundary

The profile supports the tested CJS, ESM and native erasable TypeScript paths
for `node:test`. It rejects custom collectors, command/prepare/environment
overrides, other configured runners and disabled required mutation. It uses a
cooperative read-only boundary with persistent caught-denial evidence, not a
hostile-code sandbox. Native extensions, arbitrary loaders, subprocesses,
workers, network access and uncontrolled external services remain unsupported.
The default input policy is `strict-v1`. The separately named
`--input-policy express-root-npmrc-opaque-v1` is explicit opt-in to the owner's
approved opaque root `.npmrc` exclusion. It never reads or hashes that file's
contents; subject access refuses. Both preparation and request must name the
same policy. Git metadata and opaque-file presence remain bound. This is an
exclusion from the observable input contract, not verification of its contents.

Jest and Vitest require their own guarded VM/transform and worker bridges.
Python requires a complete metadata observation boundary. Go, Rust and Ruby
require native enforcement before selective support can be claimed. An
unsupported profile is visibly incomplete, not a successful selective check.

MCP exposes equivalent strict tools: `cupel_pr_producer`, `cupel_pr_prepare` and
`cupel_pr`. Their schemas require the profile, exact base, independent pins and
external output paths. They return the same distinct scoped data without report
paging or cached execution. Source, installed-package and real-workload
acceptance are tracked separately in [release readiness](../plans/RELEASE-READINESS.md).
