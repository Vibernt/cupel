# Public input format

An importer or collector writes one JSON document matching the [input schema](../../spec/schemas/input.schema.json). The engine reads it through `cupel import <file> --format cupel` or commands such as `cupel report --input <file>`. Run `cupel validate <file>` first. The [worked JSON](example-input.json) contains one source and one test; its runtime and hash are illustrative, not measured values.

The mandatory top-level fields are `spec: "cupel-spec/1"`, `kind: "input"`, `runtime`, `sources`, `tests` and `coverage`. Source paths and test files use repository-relative `/` paths. `sources.<path>.coverable` is a canonical line set such as `"2,4-6"`. A source `hash` is optional but guard compares lost lines only for equal, present hashes; use a stable content hash of the actual source bytes. The static example omits it because no source file was measured.

Each leaf test has an id, file, name and `passed`, `failed` or `skipped` status. The stable id format and separate `unit` for parameterized rows are defined by [K10](../../spec/SPEC.md#14-collector-obligations-proved-by-the-adapter-kit-not-by-engine-cases). Include tier `tags` when the runner exposes them. At `test` granularity, `coverage.byTest` maps test ids to per-source covered line sets; `coverage.setup` maps test files to lines reached by module loading and file-level hooks. At `file` granularity use `coverage.byFile`, without pretending it identifies individual tests. The line attribution and hook boundary rules are [K1–K3](../../spec/SPEC.md#14-collector-obligations-proved-by-the-adapter-kit-not-by-engine-cases).

`mutation`, `brittleness`, `shapes`, `functionSites`, `runStatuses`, `durationsMs` and `runtimes` add evidence only when actually measured. A missing observation is not a zero. Mutant ids must be stable, a kill requires a reported test failure, and a process crash is an environment error. Multiple runners require unique test ids and per-test `runner` values (K14).

```sh
cupel validate ./my-input.json
cupel import ./my-input.json --format cupel --out ./validated-input.json
cupel report --input ./validated-input.json --json
```

For JUnit XML, `cupel import --format junit results.xml` already converts test statuses and durations. JUnit without measured coverage has no per-test coverage evidence. A converter for another tool should preserve its provenance and refuse malformed, unknown or incomplete observations; it should not make up coverage or mutation results.
