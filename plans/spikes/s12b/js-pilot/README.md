# S12b JavaScript dependency evidence pilot

## Method

`node --test plans/spikes/s12b/js-pilot/pilot.test.mjs` creates ignored fixtures
under `.scratch/s12b/` using the S12 source pin, then runs the installed
node:test, Vitest 4.1.11, and Jest 30.2.0. The trace preload observes Node
filesystem calls, the CommonJS resolver, and an ESM resolution hook. Each test
file gets a fresh process, so its module cache and observed runtime reads have
one file owner. The driver also runs each fixture's ordinary full suite.

The importable API is `captureJsDependencies({ runner, root, files, out,
version, binding })` from `capture.mjs`. `files` are explicit paths relative to
`root`; `out` is an ignored artifact directory. Optional `binding` contains
canonical `configHash` and `environmentPolicyHash` from the caller. The result
has `{ sidecar, timings }`, with sidecar version
`cupel-pr-dependencies/1`. The isolation identity is
`experimental-fresh-process-per-file`.

## Actual runtime results (Node 26.7.0)

| Runner | Fixture setup | Ordinary full | Traced 11 files | Events | Finished |
| --- | ---: | ---: | ---: | ---: | ---: |
| node:test | 2 ms | 119 ms | 1,240 ms (108–118/file) | 109 | 11/11 |
| Vitest 4.1.11 | 7 ms | 368 ms | 4,557 ms (391–510/file) | 623 | 11/11 |
| Jest 30.2.0 | 2 ms | 368 ms | 3,603 ms (296–561/file) | 874 | 11/11 |

All ordinary full runs exited zero, all 33 traced file runs exited zero, and
the actual-runtime assertion passed. The trace observed the S12 source-text
read from `tests/text.test.*` to `src/text.*` in all three runners. It observed
`config.json` read during module evaluation in both cache test files, a
captured `readFileSync` alias, `fs/promises.readFile`, a read stream, absent
`existsSync`/`statSync` probes, and a `src` directory listing. Node's ESM
resolve hook observed a source import in the runtime text test. The Vitest and
Jest loaders did not expose source import lineage through the Node resolver
hooks; their transform reads were observed instead. Jest scans many files, making its
file-owned reads conservative and imprecise.

## Verdict

**Capability evidence passes; selective PR dependency contract remains
unsupported.** The sidecar intentionally lists unproven descriptor, symlink,
outside-boundary, child process, worker, native I/O, and custom loader
channels. It also flags unowned setup/transform observations globally. The
probe cannot assert that no unobserved access exists. The ordinary full runs
only establish passing status parity for this fixture; per-test result and
setup parity were not established. Fresh-process isolation is not the ordinary
runner mode and is therefore named explicitly. A selector must refuse this
sidecar; clearing unsupported entries would require hard controls and actual
negative tests. The timing figures are setup and runtime costs, not a speedup
claim.

Raw output, sidecars, and JSONL events are under `.scratch/s12b/` and ignored
by Git. This pilot makes no Cupel production collector or CLI changes.
