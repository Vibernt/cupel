# Framework adapter template

A framework adapter connects a runner to the public [input format](input.md). It is a command outside Cupel's process. The normative interface is [SPEC.md section 15](../../spec/SPEC.md#15-framework-adapter-contract-d12); collector obligations are [K1–K14](../../spec/SPEC.md#14-collector-obligations-proved-by-the-adapter-kit-not-by-engine-cases). Keep runner-specific discovery, selection, event handling and line mapping in separate small modules.

## Four operations

1. **List:** ask the runner for leaf tests. Emit stable, sorted ids of the form `<file>::<full name>`; a suite separator is ` > `. Parameterized rows have distinct ids and the same definition-level `unit`. Preserve title tags. Do not use line numbers as ids.
2. **Select:** accept exact ids or units, translate them to the runner's filter and verify that the executed set equals the requested set. A substring filter is unsafe unless the adapter checks its result and rejects extras or omissions. A test spawning another interpreter needs `spawnsInterpreter: true` if its child coverage is invisible.
3. **Boundaries:** collect coverable and covered original-source lines. Attribute module loading and file-level `before`/`after` hooks to `coverage.setup`; attribute `beforeEach`, `afterEach` and test teardown to the test. Overlapping concurrent coverage belongs to every overlapping test and cannot become unique to one. If requested boundaries are unavailable, stop and explain why. A file-granularity mode must be an explicit user choice, report `file` with `byFile`, and never label its evidence `test` granularity.
4. **Tags:** map only the framework's actual title, marker, annotation or group idiom to `critical`, `standard` or `minor`. Keep unknown explicit tags visible so `cupel label` can reject them.

`--recheck <unit>` means rerun that unit in its own process, replace its shared-process coverage and list the unit in `coverage.rechecked`. `--runs N` means N measured runs; include `runStatuses` and `durationsMs` when observed, and put inconsistent covered lines in `coverage.unstable` (K13). Runner crashes before test results are environmental failures. A mutation kill requires a reported failing test; never infer one from a process exit alone.

## Command layout

The current collector CLI calls one external command with `--root`, `--runs`, `--out` and repeated `--recheck`. A practical Node layout is:

```text
tools/cupel-myframework/
  main.mjs        parse args, write JSON, surface errors
  list.mjs        enumerate leaf tests and stable ids
  select.mjs      exact test selection and verification
  coverage.mjs    source mapping and hook boundaries
  tags.mjs        framework tag mapping
```

The command writes JSON to the `--out` path and exits nonzero on an unsupported selection or coverage mode. Its output must pass `cupel validate <out-file>`. It must not read `expected.json` from a conformance fixture to manufacture a pass. The [external command guide](collectors.md) gives its invocation and config.

## Fixture walkthrough

The checked-in [node:test fixture](../../spec/conformance/adapters/node-test/) is a small example of the evidence a framework adapter must recover. `tests/math.test.mjs` contains a tagged `add` test, three parameterized `clamp` rows and a nested suite test. Its `expected.json` specifies exact ids, the shared `unit` for the three rows, tags, original-source line sets, and setup coverage. The adapter must derive those values from the fixture's source and executed runner events. Read [K10](../../spec/SPEC.md#14-collector-obligations-proved-by-the-adapter-kit-not-by-engine-cases) before implementing row ids: moving unrelated lines may not change a unit id.

For another framework, start from a new tiny fixture with one source file and tests for a pass, a failure, a skip, a nested suite, parameterized rows, setup hooks, per-test hooks, a critical tag and exact selection. Keep source and expected input in the fixture; record the runtime used to obtain expected line sets. Test both the positive output and errors from a missing requested test, a runner crash and an unsupported coverage mode. Then run the framework's actual runtime on a real repository.

## Conformance

From this repository, run:

```sh
node packages/cupel/bin/cupel.mjs conformance --adapter "node /absolute/path/to/my-adapter.mjs" --fixtures spec/conformance/adapters --json
```

The current command runs the adapter in each fixture directory, parses **standard output** as input JSON, checks the schema and matches `expected.json`. It reports a mismatch with exit 1 and an unavailable command/fixture with exit 3. This fixture-output check does not itself call separate list/select/boundaries/tags subcommands; exercise those operations in your adapter's own tests as described above. The conformance fixture must match the runner/language the command supports; `--fixtures` can point to a directory containing only that framework's fixture. An adapter may be valid for its framework without claiming every checked-in language fixture.

Report a status-only collector's pass as **fixture-output acceptance**. Report
full adapter acceptance only when separate tests prove all four operations,
including measured boundaries and actual tag preservation. An empty coverage
object can be honest status-only input; it cannot satisfy the boundaries gate.
