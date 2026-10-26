# S12b scoped Node file profile

## Method and API

`captureNodeProfile` in `launch.mjs` supports exact Node 22.23.3 and 26.7.0.
It starts one trusted process per test file with Node permissions, a synchronous
module-resolution hook, filesystem and descriptor observers, fixed nonsecret
environment, private TMP, and a JSON test-event reporter. The strict policy
uses ordinary Node test execution as the full baseline oracle. This is cooperative scoped
feedback for ordinary file-isolated, non-flaky tests; it is not a hostile-code
sandbox or a replacement for the full guard.

`captureNodeProfile({mode:'baseline',root,files,out,nodePath})` returns a
versioned dependency sidecar, timings, `ordinaryFull`, and `constrainedFull`.
The baseline compares exact `{file,id,status}` rows. `nodeProfileIdentity`
computes config, environment, input-manifest, lock, and trusted-runtime hashes.
The caller cannot override actual config or policy hashes.
Each capture reuses one in-request privacy preflight, lock read, runtime
version, and identity calculation. The current Node process uses its own
version without a version-probe process. Fresh input, lock, and observed
dependency checks still run after execution; caller-provided snapshots refuse.

`inputPolicy` defaults to `strict-v1`. The only opt-in is
`express-root-npmrc-opaque-v1` for the separately approved, tracked Express
root `.npmrc`. It lstat-checks that exact entry as a regular file with one
link, then excludes its bytes from reads, hashes, and the input manifest.
Presence (`absent` or `regular`) and the exact policy ID bind both config and
environment identity. Nested, case-variant, and other credential-like paths
retain strict refusal. Runtime access to the opaque entry, aliases, missing
path probes, and root directory enumeration produces persistent denials.

Opt-in baseline capture runs a **privacy-guarded full** Node test reference
with the normal test inventory and Node file isolation. Its separate guard
trace must show one completed test child per file, a completed parent, and no
caught denials; otherwise the sidecar refuses. This is not an unmodified
native full run. `ordinaryFull.privacyGuarded` labels the measured time, and
`sidecar.fullReferenceGuard` records the completeness proof. Selected-head
capture requires the verified baseline privacy proof and does not rerun full.

`captureNodeProfile({mode:'selected-head',root,files,fullFiles,out,nodePath,
binding})` runs only selected `files`, once. `fullFiles` is the complete head
test universe, including new tests. `binding` supplies verified baseline
config/parity, policy/runtime/lock hashes, and baseline observed dependency
bytes. The profile rechecks these before execution, records the head config and
input manifest, and returns `selectedHead:{rows,ms}` with `ordinaryFull:null`.
It never calls this selected run a measured full parity run. `compareFull:false`
is reserved for negative-control tests and emits a refusal marker.

Each owner has `filesystemEvents` entries containing `{channel,path,operation,
origin}` for repository FS invocations. Exact trusted Node loader frames get
`loader`; direct repository or locked dependency code gets `application`;
unresolved stacks get `unknown` and retain conservative selection. Aggregated
`reads`, `probes`, `directories`, and `writes` remain complete dependency sets.
Native module I/O does not create an application FS observer, while top-level
reads and explicit source-text reads do, including when they overlap imports.

The input reader completes a metadata-only preflight before opening source:
it prunes `.git`, rejects credential-like paths and symlinks, and hashes normal
inputs. A supported npm v2/v3 lock permits only locally installed locked
packages; the profile performs no install or lifecycle action. Actual
transitive JS/JSON files and owning package metadata receive content hashes.
Observed dependency bytes and the lock must match the bound baseline at head.
Native erasable `.ts`, `.mts`, and `.cts` use the exact Node runtime's built-in
type stripping and retain raw source hashes. TSX, unsupported syntax, custom
loaders, native addons, WASM, external inputs, child/worker processes, and
network access refuse.

## Measured controls

- The nine local control suites passed **70/70** targeted tests under both Node
  22.23.3 and 26.7.0. Both versions passed exact ordinary/constrained CJS+ESM
  parity, source-text pin, cache reads, callback/promise/stream/FD/FileHandle
  reads, negative probes, directory listing, and a new-test selected-head run
  that omitted the ordinary full execution.
- Twenty-four caught denial variants per version remained in the sidecar even
  when a test handled the exception. Separate controls exercised time,
  randomness, performance, process resource state, built-in crypto, private
  versus cross-file TMP, symlinks, missing results, and truncated hook logs.
  Deterministic `new Date(explicit)`, `Date.parse`, `Date.UTC`, and ordinary math
  continued to work.
- The locked dependency fixture passed transitive CJS and ESM imports, cached
  module reads, top-level repository reads, observed JS/package-metadata
  hashes, changed installed bytes, lock mismatch, and denied dependency API.
- Native TypeScript controls passed on both versions: source edge/raw hash,
  cached import, changed behavior caught by full and strict-subset selected
  head, unsupported enum syntax, and TSX refusal.
- Invocation-origin controls passed on both versions: import-only CJS, ESM,
  and native TS were loader events; top-level CJS/TS reads, same-path explicit
  reads, callback/promise/stream reads, and source-text pin were application
  events. An unparseable stack stayed `unknown` and conservative.
- The request snapshot control measured two reads of a fixture test file
  (preflight and post-run) and four lockfile reads (inventory plus metadata
  at each boundary); a caller-supplied snapshot refused. Separate mutation
  handshakes proved that changed inputs, lock data, and selected-head
  dependency bytes refuse after execution.
- Opaque controls proved zero content reads/hashes for the excluded root file,
  preflight refusal for symlinks, hardlinks, FIFO, directory, nested/case and
  other private names, and policy/presence identity drift. Both runtimes
  completed privacy-guarded full versus constrained parity, then retained
  caught FS/module/child-process denials in separate full and constrained
  traces. Missing opaque paths still denied negative probes. A preload spy
  observed zero calls to original content APIs for direct, hardlink, and
  symlink paths. Missing, truncated, and malformed full traces refused.
- At final runtime hash
  `sha256:67cb560222d1667eb7628e9b09db586f814167c815e2c21a61e66e5528de230b`,
  all four original matrices (Node 22/26 × strict/opaque) passed. Each ran
  15 scenarios with 10 injected faults, zero false greens, and 7 changed-code
  strict subsets. Evidence/selection tests passed 23/23 under both harnesses.
- The pinned complete Express lane passed **65/65** on Node 26.7.0 with
  exact collector/full parity and complete privacy proofs. Both source faults
  were caught using 2/4 and 1/4 files. Across five alternating pairs per fault,
  entire selection API medians were **414 vs 133 ms** and **327 vs 131 ms**
  for privacy-guarded full execution. Selection was slower in all ten pairs.
  See [the real-lane report](../real-lane/README.md).

## Verdict and boundary

The tested profile now advertises the frozen capability IDs. A selected-head
sidecar binds the baseline parity proof instead of claiming head full parity.
Any actual denial, missing result/trace, unsupported syntax or module,
changed lock/observed dependency bytes, symlink, or changed input inventory
still causes refusal. There is no fallback in this API. The tested mechanism
passes its bounded safety gate, but the real latency gate fails. The spike is
concluded without production CLI/MCP promotion or further performance work.

Setup, baseline capture, selection, instrumentation, and selected execution
costs must be reported separately. File isolation and ordinary full-suite
parity are required; timers and shared-memory races are not solved by these
guards.

Exact-version Node references: [module hooks](https://nodejs.org/download/release/v22.23.3/docs/api/module.html)
and [permissions](https://nodejs.org/download/release/v26.7.0/docs/api/permissions.html).
