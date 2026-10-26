# Collector repairs — 2026-10-25

## Ruby generated test declarations

The saved ActiveAgent failure came from
`actionagent/test/sandbox_manifest_test.rb:258`: loop-generated ActiveSupport
`test "…#{…}" do` methods share a source location, but Cupel only recognized
`define_method` at that location. Declaration parsing now handles the test DSL
without inventing a unit name. Ambiguous or malformed declarations still error.

Regression coverage includes the declaration parser, invalid declarations and a
real collector smoke with two generated rows sharing one stable unit. The Ruby
package suite passed 17 tests / 75 assertions with no failures or skips.

An independent real-file run used the existing Ruby benchmark container and
cached dependencies with `--network none`:

```
ruby /cupel/packages/cupel-ruby/bin/cupel-ruby collect --root /work \
  --runs 1 --out /work/.scratch/release-readiness/ruby-input.json \
  -- actionagent/test/sandbox_manifest_test.rb
```

Result: exit 0, 25 passed tests, including the two generated rows, in 5.55 s
container wall time. This verifies the previously failing source declaration;
the entire mixed Ruby/Node benchmark has not been rerun. Existing baseline
failures elsewhere are not resolved by this fix.

## Rust LLVM export memory

The retained error log shows V8 heap exhaustion near its 4 GB limit while
`JSON.parse` built the LLVM export array. The collector now writes LLVM output
to a scratch file, validates/parses it incrementally, maps one file at a time,
releases each run's expanded line sets after folding them into source scope,
and bounds collection to two concurrent jobs. Source mapping uses a compact
character mask and caches a single source line for UTF-8 column conversion.

Regression cases cover streaming across arbitrary chunks, Unicode byte columns,
invalid/truncated JSON, file output, a 32 MiB export under a 64 MiB V8 heap and
the existing collector/conformance tests. Targeted Node 26 tests passed; Node 22
targeted checks also passed during implementation. Final full gates are recorded
separately after all changes settle.

Worker microbenchmarks: a 20,000-line / 40,000-segment synthetic source mapped in
61 ms, with 56 MB final RSS and 91 MB process maximum RSS. A 32 MiB metadata export
parsed under a 64 MiB heap in 247 ms, with 46 MB final RSS and 83 MB maximum RSS.
These are synthetic memory/latency observations, not a real-repository speedup.

The affected Tauri crate was then exercised in its existing cached container,
offline, with an explicitly bounded single-file selection:

```
node /cupel/packages/cupel/bin/cupel.mjs collect-cargo \
  --root /work/src-tauri --tests src/linux_media.rs --runs 1 \
  --out /work/.scratch/release-readiness/cargo-input.json
```

Result: exit 0 in 77.31 s container wall time. The container lacked
`/usr/bin/time`; the first measured attempt stopped with exit 127 before collection.
The owner explicitly chose to run collection and report synthetic memory
separately. No real-run peak-memory number is asserted. The full Rust suite and
full Vitest+Rust benchmark remain unverified.

## Evidence and next action

Raw validation outputs are ignored under `.scratch/release-readiness/`; collector
inputs remain under each benchmark checkout's `.scratch/release-readiness/`.
No original Assay or CodeCrystal files changed. No alternate runner, smaller
production scope or larger heap was substituted for the failing benchmark.
The explicit single-file runs above are regression acceptance slices, not
replacements for that benchmark.

Next best action: finish benchmark provenance, then validate Jest and the PR
selection safety matrix before making broader release or performance claims.
