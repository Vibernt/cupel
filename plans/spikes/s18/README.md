# S18 sealed baseline selection prototype

This experimental host-side path separates a trusted **prepare** from repeated
selected-HEAD **consume** requests. It does not alter the shipped Cupel product,
the S16 selector, the S12b test hook, or the pure engine.

## Contract

`prepareSealedBaseline({ baseRoot, baseCommit, input, fullFiles, inputPolicy,
nodePath, out, expectedProducerHash })` runs the real ordinary and constrained
Node profile on the trusted baseline. It validates complete parity, collector
rows, privacy proof, locked dependencies, source hashes, critical labels, and
producer source before writing `sealed-baseline.json` once with mode `0600`.
The returned `artifactHash` is SHA-256 of the exact raw JSON bytes. The artifact
contains a version, base commit, policy, producer identity, canonical file
inventory, original input and rows, dependency closure, and baseline trace. It
contains no baseline-root path or `.npmrc` contents. The file is capped at 64 MiB.

`runSealedSelectedHead({ artifactPath, expectedArtifactHash,
expectedBaseCommit, expectedProducerHash, headRoot, nodePath, inputPolicy,
out })` accepts exactly those fields. The path must name a regular
`sealed-baseline.json` file. It reads the artifact once, checks the
independent raw hash and producer pin, reconstructs baseline labels and trace
proof from the saved inventory, and never consults the baseline checkout or
its installed packages. Missing, corrupt, stale, incompatible, or oversized
artifacts explicitly refuse. It never recaptures the baseline.

Each consume request discovers the supported HEAD test-file universe from a
fresh metadata-only walk of `tests/`, then verifies it against the complete
fresh S16 byte-hashed preflight. It runs the S16 selector, isolated selected
processes, and fresh postflight. A new supported test is selected. A removed
test or unknown source still refuses. Non-code D16 changes return a full route
that requires a separate full oracle; no full run is hidden inside this API.
Fresh HEAD bytes, opaque descriptor, lock, installed package metadata, observed
dependency bytes, Node binary, runtime, policy and producer source are checked.
The result is scoped selected-file evidence, never a whole-suite guard pass.

## Trust and measurement boundary

A SHA-256 digest establishes byte identity, not authenticity. The caller must
obtain `expectedArtifactHash`, `expectedBaseCommit`, and
`expectedProducerHash` from trusted storage outside the proposing agent's
write scope. Rewriting an artifact and replacing its pin does not create a
trusted baseline. Preparation belongs to the trusted baseline workflow.
The `baseCommit` argument is a caller attestation; the trusted preparation
workflow must verify Git metadata independently before passing it.

The focused tests use actual Node 22.23.3 and 26.7.0 profile processes. They
exercise an unavailable baseline after preparation, same-size/source-byte
changes with restored mtime, new HEAD tests, D16 routing, opaque `.npmrc`
presence, installed dependency changes, malformed and repinned proof changes,
wrong pins/runtime/policy, and context injection. The `baselineRootReads: 0`
counter states the consume contract; the unavailable-baseline test supplies
the behavioral check. Whole-call timing and speed verdict belong in the S18
benchmark record, not the focused test duration.

The four-mode oracle and focused-test evidence is in
[`MATRIX-RESULTS.md`](MATRIX-RESULTS.md). The real Express lane's five-pair
whole-call comparison, one-time setup accounting, artifact cost and verdict
are in [`measure/RESULTS.md`](measure/RESULTS.md). S18 was faster than S16
selection in both measured faults, but slower than privacy-guarded full
execution in every pair; this prototype is not promoted as a latency win.
