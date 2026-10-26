# Docs-only Python unittest adapter consumer

Built using only the public extending docs, CLI reference, linked SPEC sections 14–16, and public schemas. The implementation is a standalone Python script using `unittest`, `sys.settrace`, `tokenize`, and the standard library. It reads no Cupel source or existing collector.

## Four stdout operations

- `--list`: sorted leaf inventory with stable `<file>::<full test name>` IDs, file, name, and tags. No unit is emitted because the fixture has no parameterized definitions.
- `--select ID [ID ...]`: executes exactly the requested IDs and writes a Cupel input document to stdout; unknown or duplicate IDs fail with exit 3. The smoke test checks one valid ID alone and a valid ID mixed with an extra unknown ID.
- `--boundaries`: executes the selected fixture and writes measured input with per-test and setup source lines.
- `--tags`: lists tags separately. It maps `[critical]` from the first line of `TestCase.shortDescription()`, the unittest description idiom used by the fixture.

With no operation flag, the adapter emits the same measured input for Cupel's conformance command. When Cupel invokes it as an external collector, `--out` writes the document to the requested file. `--recheck` returns an explicit unsupported error; `--runs` accepts exactly one run. Fresh-process recheck and repeated-run instability are unverified.

## Measurement details

Tracing starts before test discovery, so executed source module definitions are recorded under `coverage.setup`. `TestResult.startTest`/`stopTest` delimit each test's coverage, including per-test setup and teardown. Source files and coverable lines come from the fixture's `src/` tree and Python's tokenizer; source hashes are SHA-256 of actual bytes. Each test has measured status, `runStatuses`, and `durationsMs`. The deliberate assertion failure is recorded as failed; the skip remains skipped.

The hand-written `expected.json` asserts coverable lines, observed pass/fail/skip statuses, the critical tag, setup lines and exact per-test coverage. The adapter never reads it. The fixture is small and sequential. It does not verify concurrent coverage, child interpreter coverage, parameterized units, rechecks, or multi-run unstable lines.

## Commands

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s docs/extending/unittest-example/smoke -v
PYTHONDONTWRITEBYTECODE=1 node packages/cupel/bin/cupel.mjs conformance --adapter "python3 ../../adapter.py" --fixtures docs/extending/unittest-example/conformance --json
```

From `docs/extending/unittest-example/conformance/unittest-basic`:

```sh
PYTHONDONTWRITEBYTECODE=1 node ../../../../../packages/cupel/bin/cupel.mjs report --config cupel.json --no-mutation --runs 1 --out ../../../../../.scratch/unittest-example-input.json
node ../../../../../packages/cupel/bin/cupel.mjs validate ../../../../../.scratch/unittest-example-input.json --json
```

The independent consumer's raw results remain ignored under
`.scratch/docs-only-adapter/results.json`. Repository tests preserve the six
operation smoke cases and the hand-derived conformance fixture. This example is
an independently built proof of the bounded four-operation interface; it is not
a production unittest collector and does not satisfy the unimplemented K13 or
fresh-process recheck obligations.
