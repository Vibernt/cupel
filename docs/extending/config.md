# Config extensions

Write `cupel.json` at the repository root and check it with `cupel validate cupel.json`. Every key and allowed value is in the [config schema](../../spec/schemas/config.schema.json). These rules are data, not executable plugins.

```json
{
  "spec": "cupel-spec/1",
  "scope": { "include": ["src/**"], "exclude": ["src/generated/**"] },
  "tiers": {
    "critical": ["tests/auth/**"],
    "minor": ["tests/examples/**"],
    "extraPathWords": ["settlement"],
    "extraTitleWords": ["fraud"]
  },
  "brittleness": {
    "patterns": [
      { "kind": "source-text", "language": "javascript", "pattern": "readFileSync\\s*\\(", "description": "Review tests that pin source text" }
    ]
  }
}
```

`tiers.critical` and `tiers.minor` are path patterns; title tags such as `[critical]`, `[standard]` and `[minor]` can mark individual tests. Built-in critical path/title words remain active; `extraPathWords` and `extraTitleWords` add words without replacing them. `pathWords` and `titleWords` replace the corresponding defaults if explicitly supplied. A word that tokenizes to nothing is invalid. An unknown tier tag is a label error, not silently ignored. See [SPEC.md section 5](../../spec/SPEC.md) for precedence and matching.

The example brittleness pattern is a regular-expression string interpreted by a collector for matching test source. A finding in the input has `{ "test": "<id>", "kind": "source-text" }`; the engine does not scan source or execute the regex. Collector support for a language and pattern kind must be checked before depending on it. Mark a deliberate source pin with `deliberate: true` in its finding. Avoid rules that flag every test.

For guard enforcement, keep the effective config outside a proposed change's write scope. The [Action](../../action/README.md) reads `cupel.json` from the exact trusted base commit. Test a rule with `cupel label --input <measured-input> --config cupel.json --json`; a config file alone cannot demonstrate that a collector produced expected tags or findings.

## Code that another language's tests run

When one language's code is built into an artifact that another language's
tests load, such as Rust crates compiled to a WebAssembly module that a Worker
runs in workerd, name it with `builtInto` (source glob → artifact path):

```json
{ "builtInto": { "crates/wasm/**": "cloud/src/prill.wasm" } }
```

The workerd collector records, per test, which repository `.wasm` files the
Worker loaded (matched by their bytes) as the test's `loads`. A matching source
that no test covers in its own language is then reported as `unmeasured`, for
example "built into cloud/src/prill.wasm, which 72 tests load; lines inside
WebAssembly are not measured", instead of looking untested. A source that its own
tests do reach keeps its measured coverage. Rust faults in such sources are left
out of fault testing, since no Rust test can run them.

### Re-testing Rust faults with the tests that load the artifact

Rust faults that `cargo test` did not catch, in sources that are also built into
the artifact, can get a second chance with the tests that load it. This is opt-in
and capped, because every fault costs a build and a test run:

```json
{ "runners": { "cargo": { "mutants": { "crossRunner": {
  "sources": "crates/core/**", "artifact": "cloud/src/prill.wasm",
  "build": "sh tools/build-wasm.sh", "maxMutants": 20 } } } } }
```

In a scratch copy of the project, Cupel plants each fault, runs `build`, then runs
the test files whose tests loaded `artifact`, after one unmutated baseline. A test
that now fails catches the fault and is credited. A fault the build rejects is
skipped. Faults in sources that are only built into the artifact (and so are
`unmeasured`) have no lines to attach results to and are not re-tested.
